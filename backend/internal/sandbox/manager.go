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

var images = map[string]string{
	"opencode":    "opencode-sandbox:dev",
	"claude-code": "claude-code-sandbox:dev",
	"codex":       "codex-sandbox:dev",
	"hermes":      "hermes-sandbox:dev",
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

	base := strings.TrimRight(m.cfg.ModelAPIBase, "/")
	if m.cfg.ModelAPIStyle == "anthropic" {
		env["ANTHROPIC_BASE_URL"] = base
		env["ANTHROPIC_API_KEY"] = m.cfg.ModelAPIKey
	} else {
		env["OPENAI_BASE_URL"] = base
		env["OPENAI_API_KEY"] = m.cfg.ModelAPIKey
	}
	// claude-code SDK always wants ANTHROPIC_* regardless of proxy style
	if inst.Type == "claude-code" {
		env["ANTHROPIC_BASE_URL"] = base
		env["ANTHROPIC_API_KEY"] = m.cfg.ModelAPIKey
	}
	// codex CLI 写死从 OPENAI_API_KEY 读 key，即便 gateway 是 anthropic 风格也要塞
	if inst.Type == "codex" {
		env["OPENAI_BASE_URL"] = base
		env["OPENAI_API_KEY"] = m.cfg.ModelAPIKey
	}

	spec := k8s.SandboxSpec{
		Name:          name,
		SessionID:     inst.HarnessID.String(),
		HarnessID:     inst.HarnessID.String(),
		HarnessImage:  image,
		ContainerPort: Port,
		Env:           env,
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
