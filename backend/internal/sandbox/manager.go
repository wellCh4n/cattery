// Package sandbox 负责 project agent sandbox 的生命周期（启动 / 等待就绪 / 停止）。
// 每个 project 一个 sandbox，按需拉起（创建 session / 发消息 / 读历史时）。
package sandbox

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/db"
	"github.com/wellch4n/cattery/internal/harness"
	"github.com/wellch4n/cattery/internal/k8s"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// Port 是 agent sandbox 容器对外暴露的端口。
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

// Image is the agent sandbox image (harnesses/pi). `make build-harness` builds it.
const Image = "cattery-pi:dev"

// SkillsMountPath is where the global skill library is mounted (read-only) in
// the agent container. The pi harness lists <slug>/SKILL.md entries from here
// in its system prompt (HOME=/home/node).
const SkillsMountPath = "/home/node/.agents/skills"

type Manager struct {
	store         *db.ProjectStore
	k8sClient     *k8s.Client
	harnessClient *harness.Client
	cfg           *config.Config

	// locks serializes EnsureReady per project so concurrent session creates
	// and message sends don't race each other into a double start.
	locks sync.Map // uuid.UUID → *sync.Mutex
}

func NewManager(store *db.ProjectStore, k8sClient *k8s.Client, harnessClient *harness.Client, cfg *config.Config) *Manager {
	return &Manager{store: store, k8sClient: k8sClient, harnessClient: harnessClient, cfg: cfg}
}

// NameFor 生成 project 的 K8s Sandbox 资源名，形如 `cattery-sandbox-<project_id>`。
func NameFor(projectID uuid.UUID) string {
	return fmt.Sprintf("cattery-sandbox-%s", projectID.String())
}

func PVCNameForProjectID(projectID uuid.UUID) string {
	return fmt.Sprintf("cattery-project-%s-work", projectID.String())
}

func (m *Manager) lock(projectID uuid.UUID) func() {
	v, _ := m.locks.LoadOrStore(projectID, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// EnsureReady 确保 project 的 agent sandbox 在线并返回其 URL：
//   - 已在运行：直接返回（pod IP 每次都从 K8s 现查，不入库）
//   - 否则：拉起 Sandbox CR 并等待 ready
//
// 耗时可达分钟级；同一 project 的并发调用会排队，后到的直接复用结果。
func (m *Manager) EnsureReady(ctx context.Context, projectID uuid.UUID) (string, error) {
	name := NameFor(projectID)
	if url, ok := m.k8sClient.ResolveURL(ctx, name); ok {
		return url, nil
	}

	unlock := m.lock(projectID)
	defer unlock()
	// Someone may have finished bringing it up while we waited for the lock.
	if url, ok := m.k8sClient.ResolveURL(ctx, name); ok {
		_ = m.store.UpdateSandboxStatus(ctx, projectID, "ready")
		return url, nil
	}

	env := map[string]string{
		"PORT":       fmt.Sprintf("%d", Port),
		"PROJECT_ID": projectID.String(),
	}
	// Model endpoints and keys are not baked into the pod: the backend passes
	// them with each session registration (see SessionHandler.ensureAgentSession).

	// On failure also drop the CR: its pod uses restartPolicy Never, so a
	// crashed one would otherwise sit un-Ready and every retry would wait on
	// it (RunTask tolerates AlreadyExists) instead of starting fresh.
	fail := func(err error) (string, error) {
		bg := context.Background()
		if stopErr := m.k8sClient.StopTask(bg, name); stopErr != nil && !apierrors.IsNotFound(stopErr) {
			log.Printf("warn: clean up sandbox %s: %v", name, stopErr)
		}
		_ = m.store.UpdateSandboxStatus(bg, projectID, "failed")
		return "", err
	}

	pvcName := PVCNameForProjectID(projectID)
	if err := m.k8sClient.EnsurePVC(ctx, pvcName, k8s.ComponentWorkspace, map[string]string{
		k8s.LabelProjectID: projectID.String(),
	}); err != nil {
		return fail(fmt.Errorf("ensure workspace pvc: %w", err))
	}
	// The skills PVC is normally created by the skillmgr path, but ensure it
	// here too: on a fresh cluster nobody may have opened the Skills panel yet,
	// and a missing PVC would block the sandbox Pod from scheduling.
	if err := m.k8sClient.EnsurePVC(ctx, SkillsPVCName, k8s.ComponentSkills, nil); err != nil {
		return fail(fmt.Errorf("ensure skills pvc: %w", err))
	}

	_ = m.store.UpdateSandboxStatus(ctx, projectID, "starting")
	if err := m.k8sClient.RunTask(ctx, k8s.SandboxSpec{
		Name:          name,
		ProjectID:     projectID.String(),
		Image:         Image,
		ContainerPort: Port,
		Env:           env,
		WorkspacePVC:  pvcName,
		SkillsPVC:     SkillsPVCName,
		SkillsMount:   SkillsMountPath,
	}); err != nil {
		return fail(fmt.Errorf("run sandbox: %w", err))
	}

	url, err := m.k8sClient.WaitReady(ctx, name, 3*time.Minute)
	if err != nil {
		return fail(err)
	}
	if err := m.harnessClient.WaitHTTPReady(ctx, url, 2*time.Minute); err != nil {
		return fail(err)
	}
	_ = m.store.UpdateSandboxStatus(ctx, projectID, "ready")
	return url, nil
}

// Await is EnsureReady for request handlers: the bring-up runs detached so a
// client that disconnects mid-start doesn't cancel it (a cancelled start would
// count as a failure and tear the sandbox down), while the caller stops
// waiting as soon as ctx is done.
func (m *Manager) Await(ctx context.Context, projectID uuid.UUID) (string, error) {
	if url, ok := m.URL(ctx, projectID); ok {
		return url, nil
	}
	type result struct {
		url string
		err error
	}
	ch := make(chan result, 1)
	go func() {
		url, err := m.EnsureReady(context.Background(), projectID)
		ch <- result{url, err}
	}()
	select {
	case r := <-ch:
		return r.url, r.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// URL resolves the project sandbox's current address straight from K8s. There
// is no DB cache of the pod IP (it's ephemeral and goes stale on reschedule),
// so callers resolve it fresh — once per connection. Returns ("", false) when
// the sandbox isn't Ready / has no published pod IP yet.
func (m *Manager) URL(ctx context.Context, projectID uuid.UUID) (string, bool) {
	return m.k8sClient.ResolveURL(ctx, NameFor(projectID))
}

// Stop 删除 project 的 Sandbox CR；本地状态置 idle。Session transcript 在
// workspace PVC 上，下次拉起后可继续。
func (m *Manager) Stop(ctx context.Context, projectID uuid.UUID) {
	name := NameFor(projectID)
	go func() {
		if err := m.k8sClient.StopTask(context.Background(), name); err != nil && !apierrors.IsNotFound(err) {
			log.Printf("warn: stop sandbox %s: %v", name, err)
		}
	}()
	_ = m.store.UpdateSandboxStatus(ctx, projectID, "idle")
}
