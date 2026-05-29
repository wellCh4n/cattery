// Package sandbox 负责 harness sandbox 的生命周期（启动 / 等待就绪 / 停止）。
// 既给 harness 创建路径用（创建即起），也给 session 创建路径兜底（确保 ready）。
package sandbox

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/k8s"
	"github.com/wellch4n/cattery/internal/model"
)

// Port 是所有 harness sandbox 容器对外暴露的统一端口。
const Port = 1114

// FileMgrPort 是 filemgr Pod 监听的端口。一个 project 启动时会拉起一个独立
// 的 filemgr Pod 挂载 project PVC，后端 /files 路由把请求转发到这个端口。
const FileMgrPort = 1115

// FileMgrImage 是 filemgr 镜像。`make build-pod` 构建。
const FileMgrImage = "cattery-filemgr:dev"

func FileMgrPodNameForProject(projectID uuid.UUID) string {
	return fmt.Sprintf("cattery-filemgr-%s", projectID.String())
}

// SkillMgrPort 是全局 skillmgr Pod 监听的端口。与 filemgr 不同，整个集群只有
// 一个 skillmgr，挂载全局 skills PVC 暴露 skill 库，后端把 /skills 请求代理过去。
const SkillMgrPort = 1116

// SkillMgrImage 是 skillmgr 镜像。它只暴露 skill 库需要的窄接口。
const SkillMgrImage = "cattery-skillmgr:dev"

// SkillMgrPodName 是全局唯一的 skillmgr Pod 名。skill 是全局资源，独立于任何
// project 管理，所以这里不是 per-project。
const SkillMgrPodName = "cattery-skillmgr"

// SkillsPVCName 是存放 skill 库的全局 PVC：由 skillmgr RW 挂载、（后续）由
// sandbox RO 挂载。单节点测试用 RWO 即可；生产多节点需要把该 PVC 供给为 RWX。
const SkillsPVCName = "cattery-skills-work"

var images = map[string]string{
	"opencode":    "opencode-sandbox:dev",
	"claude-code": "claude-code-sandbox:dev",
	"codex":       "codex-sandbox:dev",
	"hermes":      "hermes-sandbox:dev",
}

// skillsMountPaths maps a harness type to the in-container path where that
// harness loads skills from. Harnesses absent from this map don't consume the
// global skill library and get no skills volume. claude-code reads personal
// skills from ~/.claude/skills, and HOME=/home/node in its image.
var skillsMountPaths = map[string]string{
	"claude-code": "/home/node/.claude/skills",
}

type Manager struct {
	store         *db.HarnessStore
	k8sClient     *k8s.Client
	harnessClient *harness.Client
	cfg           *config.Config
}

func NewManager(store *db.HarnessStore, k8sClient *k8s.Client, harnessClient *harness.Client, cfg *config.Config) *Manager {
	return &Manager{store, k8sClient, harnessClient, cfg}
}

// NameFor 生成 K8s Sandbox 资源名，形如 `cattery-<type>-<harness_id>`。
// type 为空时回落到旧格式，避免删除老 sandbox 时漏掉资源。
func NameFor(inst *model.Harness) string {
	if inst.Type == "" {
		return fmt.Sprintf("cattery-%s", inst.HarnessID.String())
	}
	return fmt.Sprintf("cattery-%s-%s", inst.Type, inst.HarnessID.String())
}

func PVCNameFor(inst *model.Harness) string {
	return PVCNameForProjectID(inst.ProjectID)
}

func PVCNameForProjectID(projectID uuid.UUID) string {
	return fmt.Sprintf("cattery-project-%s-work", projectID.String())
}

// EnsureReady 确保 inst 对应的 sandbox 已就绪。
//   - 已 ready: 立刻返回 URL
//   - starting: 等待
//   - idle / failed / 空: 重新拉起后等待
//
// 调用方应在 goroutine 里调用（耗时可达分钟级）。
func (m *Manager) EnsureReady(ctx context.Context, inst *model.Harness) (string, error) {
	if inst.SandboxStatus == "ready" && inst.SandboxURL != nil {
		return *inst.SandboxURL, nil
	}

	name := NameFor(inst)

	if inst.SandboxStatus == "starting" {
		return m.waitURL(ctx, name, inst.HarnessID)
	}

	image, ok := images[inst.Type]
	if !ok {
		image = images["opencode"]
	}

	env := make(map[string]string, len(inst.EnvVars)+5)
	for k, v := range inst.EnvVars {
		env[k] = v
	}
	env["MODEL"] = inst.Model
	env["PORT"] = fmt.Sprintf("%d", Port)
	env["AGENT_ID"] = inst.HarnessID.String()
	env["PROJECT_ID"] = inst.ProjectID.String()

	provider, ok := model.ProviderForModel(inst.Model)
	if !ok {
		_ = m.store.UpdateSandboxStatus(ctx, inst.HarnessID, "failed")
		return "", fmt.Errorf("unknown provider for model %q", inst.Model)
	}
	anthropicBase := strings.TrimRight(m.cfg.AnthropicBaseURL, "/")
	openaiBase := strings.TrimRight(m.cfg.OpenAIBaseURL, "/")
	if provider == model.ProviderAnthropic {
		if anthropicBase == "" || m.cfg.AnthropicAPIKey == "" {
			_ = m.store.UpdateSandboxStatus(ctx, inst.HarnessID, "failed")
			return "", fmt.Errorf("anthropic config is required for model %q", inst.Model)
		}
		env["ANTHROPIC_BASE_URL"] = anthropicBase
		env["ANTHROPIC_API_KEY"] = m.cfg.AnthropicAPIKey
	} else {
		if openaiBase == "" || m.cfg.OpenAIAPIKey == "" {
			_ = m.store.UpdateSandboxStatus(ctx, inst.HarnessID, "failed")
			return "", fmt.Errorf("openai config is required for model %q", inst.Model)
		}
		env["OPENAI_BASE_URL"] = openaiBase
		env["OPENAI_API_KEY"] = m.cfg.OpenAIAPIKey
	}
	// claude-code SDK always wants ANTHROPIC_*; GPT models run through the
	// configured OpenAI-compatible gateway exposed via Anthropic env names.
	if inst.Type == "claude-code" {
		if provider == model.ProviderAnthropic {
			env["ANTHROPIC_BASE_URL"] = anthropicBase
			env["ANTHROPIC_API_KEY"] = m.cfg.AnthropicAPIKey
		} else {
			env["ANTHROPIC_BASE_URL"] = anthropicBase
			env["ANTHROPIC_API_KEY"] = m.cfg.AnthropicAPIKey
		}
	}
	// codex CLI and codex-relay both read OPENAI_*; Anthropic models use the
	// Anthropic-compatible gateway behind the OpenAI env names.
	if inst.Type == "codex" {
		if provider == model.ProviderAnthropic {
			env["OPENAI_BASE_URL"] = withPathSuffix(anthropicBase, "/v1")
			env["OPENAI_API_KEY"] = m.cfg.AnthropicAPIKey
		} else {
			env["OPENAI_BASE_URL"] = openaiBase
			env["OPENAI_API_KEY"] = m.cfg.OpenAIAPIKey
		}
	}

	pvcName := PVCNameFor(inst)
	if err := m.k8sClient.EnsurePVC(ctx, pvcName, k8s.ComponentWorkspace, map[string]string{
		k8s.LabelProjectID: inst.ProjectID.String(),
	}); err != nil {
		_ = m.store.UpdateSandboxStatus(ctx, inst.HarnessID, "failed")
		return "", fmt.Errorf("ensure workspace pvc: %w", err)
	}

	spec := k8s.SandboxSpec{
		Name:          name,
		SessionID:     inst.HarnessID.String(),
		HarnessID:     inst.HarnessID.String(),
		ProjectID:     inst.ProjectID.String(),
		HarnessImage:  image,
		ContainerPort: Port,
		Env:           env,
		WorkspacePVC:  pvcName,
	}

	// Mount the global skill library read-only for harnesses that consume it.
	// The skills PVC is normally created by the skillmgr path, but ensure it
	// here too: on a fresh cluster nobody may have opened the Skills panel yet,
	// and a missing PVC would block the sandbox Pod from scheduling.
	if mount, ok := skillsMountPaths[inst.Type]; ok {
		if err := m.k8sClient.EnsurePVC(ctx, SkillsPVCName, k8s.ComponentSkills, nil); err != nil {
			_ = m.store.UpdateSandboxStatus(ctx, inst.HarnessID, "failed")
			return "", fmt.Errorf("ensure skills pvc: %w", err)
		}
		spec.SkillsPVC = SkillsPVCName
		spec.SkillsMount = mount
	}

	_ = m.store.UpdateSandboxStarting(ctx, inst.HarnessID, name)
	if err := m.k8sClient.RunTask(ctx, spec); err != nil {
		_ = m.store.UpdateSandboxStatus(ctx, inst.HarnessID, "failed")
		return "", fmt.Errorf("run sandbox: %w", err)
	}

	return m.waitURL(ctx, name, inst.HarnessID)
}

func (m *Manager) waitURL(ctx context.Context, name string, harnessID uuid.UUID) (string, error) {
	url, err := m.k8sClient.WaitReady(ctx, name, 3*time.Minute)
	if err != nil {
		_ = m.store.UpdateSandboxStatus(ctx, harnessID, "failed")
		return "", err
	}
	if err := m.harnessClient.WaitHTTPReady(ctx, url, 2*time.Minute); err != nil {
		_ = m.store.UpdateSandboxStatus(ctx, harnessID, "failed")
		return "", err
	}
	_ = m.store.UpdateSandboxReady(ctx, harnessID, url)
	return url, nil
}

func withPathSuffix(base, suffix string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, suffix) {
		return base
	}
	return base + suffix
}

// Stop 删除对应的 Sandbox CR；本地状态置 idle。
func (m *Manager) Stop(ctx context.Context, inst *model.Harness) {
	name := NameFor(inst)
	go func() {
		if err := m.k8sClient.StopTask(context.Background(), name); err != nil {
			log.Printf("warn: stop sandbox %s: %v", name, err)
		}
	}()
	_ = m.store.UpdateSandboxStatus(ctx, inst.HarnessID, "idle")
}

// EnsureReadyAsync 是 EnsureReady 的 fire-and-forget 包装，用于 HarnessHandler.Create：
// 用户拿到 201 立刻返回，sandbox 在后台继续拉起，状态写到 DB 等前端轮询。
func (m *Manager) EnsureReadyAsync(inst *model.Harness) {
	go func() {
		if _, err := m.EnsureReady(context.Background(), inst); err != nil {
			log.Printf("warn: bring up sandbox for harness %s: %v", inst.HarnessID, err)
		}
	}()
}
