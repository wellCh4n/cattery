// Package sandbox 负责 project agent sandbox 的生命周期（启动 / 等待就绪 / 停止）。
// 每个 project 一个常驻 Pod，agent 容器同时提供工作区文件和应用预览。
package sandbox

import (
	"context"
	"fmt"
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

// FileMgrPodNameForProject names the standalone file service Pods of the
// oldest layout, still deleted when a project is provisioned or destroyed.
func FileMgrPodNameForProject(projectID uuid.UUID) string {
	return fmt.Sprintf("cattery-filemgr-%s", projectID.String())
}

// SkillMgrPort 是全局 skillmgr Pod 监听的端口。与 project Pod 不同，整个集群只有
// 一个 skillmgr，挂载全局 skills PVC 暴露 skill 库，后端把 /skills 请求代理过去。
const SkillMgrPort = 1116

// SkillMgrPodName 是全局唯一的 skillmgr Pod 名。skill 是全局资源，独立于任何
// project 管理，所以这里不是 per-project。
const SkillMgrPodName = "cattery-skillmgr"

// SkillsPVCName 是存放 skill 库的全局 PVC，只由 skillmgr 挂载。sandbox 不挂载它：
// skill 按需安装（复制）到项目的 ~/.agents/skills。
const SkillsPVCName = "cattery-skills-work"

// WorkspaceMountPath is the project workspace and the agent's working
// directory. HOME is /home/cattery in the pi image, so this makes the project
// workspace available as `~`.
const WorkspaceMountPath = "/home/cattery"

type Manager struct {
	store         *db.ProjectStore
	k8sClient     *k8s.Client
	harnessClient *harness.Client
	cfg           *config.Config

	// locks serializes EnsureReady per project so concurrent session creates
	// and message sends don't race each other into a double start.
	locks          sync.Map // uuid.UUID → *sync.Mutex
	provisionLocks sync.Map

	// beforeRelease runs while the agent is still reachable, just before its
	// sessions are released or its resources destroyed.
	beforeRelease func(context.Context, uuid.UUID)
}

func NewManager(store *db.ProjectStore, k8sClient *k8s.Client, harnessClient *harness.Client, cfg *config.Config) *Manager {
	return &Manager{store: store, k8sClient: k8sClient, harnessClient: harnessClient, cfg: cfg}
}

// OnRelease sets a hook run, with the agent still reachable, after Stop
// releases its sessions and before Destroy deletes the sandbox — for
// collecting what the agent recorded on its workspace. It gets a few seconds.
func (m *Manager) OnRelease(hook func(context.Context, uuid.UUID)) { m.beforeRelease = hook }

// releaseTimeout bounds the hook so it never stalls a stop or delete.
const releaseTimeout = 3 * time.Second

func (m *Manager) release(ctx context.Context, projectID uuid.UUID) {
	if m.beforeRelease != nil {
		ctx, cancel := context.WithTimeout(ctx, releaseTimeout)
		defer cancel()
		m.beforeRelease(ctx, projectID)
	}
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

// EnsureProject provisions the shared project Pod without activating agent sessions.
func (m *Manager) EnsureProject(ctx context.Context, projectID uuid.UUID) error {
	v, _ := m.provisionLocks.LoadOrStore(projectID, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	return m.ensureProject(ctx, projectID)
}

func (m *Manager) ensureProject(ctx context.Context, projectID uuid.UUID) error {
	pvcName := PVCNameForProjectID(projectID)
	if err := m.k8sClient.EnsurePVC(ctx, pvcName, k8s.ComponentWorkspace, map[string]string{k8s.LabelProjectID: projectID.String()}); err != nil {
		return err
	}
	if err := m.k8sClient.RunTask(ctx, k8s.SandboxSpec{
		Name: NameFor(projectID), ProjectID: projectID.String(), Image: m.cfg.PiImage, ContainerPort: Port,
		Env:          map[string]string{"PORT": fmt.Sprint(Port), "PROJECT_ID": projectID.String()},
		WorkspacePVC: pvcName, WorkVolumeMount: WorkspaceMountPath,
	}); err != nil {
		return err
	}
	// Clean up the obsolete standalone file service after the shared spec exists.
	return m.k8sClient.DeletePod(ctx, FileMgrPodNameForProject(projectID))
}

// FileURL answers the agent's URL for file operations and app previews once
// its container is ready, without activating agent sessions.
func (m *Manager) FileURL(ctx context.Context, projectID uuid.UUID) (string, error) {
	if url, ok := m.k8sClient.ResolveContainerURL(ctx, NameFor(projectID), "agent", Port); ok {
		return url, nil
	}
	if err := m.EnsureProject(ctx, projectID); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	return m.k8sClient.WaitContainerReady(ctx, NameFor(projectID), "agent", Port)
}

func (m *Manager) EnsureReady(ctx context.Context, projectID uuid.UUID) (string, error) {
	unlock := m.lock(projectID)
	defer unlock()
	if err := m.EnsureProject(ctx, projectID); err != nil {
		_ = m.store.UpdateSandboxStatus(ctx, projectID, "failed")
		return "", err
	}
	if url, ok := m.URL(ctx, projectID); ok {
		_ = m.store.UpdateSandboxStatus(ctx, projectID, "ready")
		return url, nil
	}
	_ = m.store.UpdateSandboxStatus(ctx, projectID, "starting")
	readyCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	url, err := m.k8sClient.WaitContainerReady(readyCtx, NameFor(projectID), "agent", Port)
	if err == nil {
		err = m.harnessClient.WaitHTTPReady(readyCtx, url, 2*time.Minute)
	}
	if err != nil {
		// Keep the shared Pod and file service alive when the agent is unhealthy.
		_ = m.store.UpdateSandboxStatus(context.Background(), projectID, "failed")
		return "", err
	}
	_ = m.store.UpdateSandboxStatus(ctx, projectID, "ready")
	return url, nil
}

// Await is EnsureReady for request handlers: the bring-up runs detached so a
// client that disconnects mid-start does not cancel provisioning, while it stops
// waiting as soon as ctx is done.
func (m *Manager) Await(ctx context.Context, projectID uuid.UUID) (string, error) {
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
// the agent container is not ready or has no published Pod IP yet.
func (m *Manager) URL(ctx context.Context, projectID uuid.UUID) (string, bool) {
	return m.k8sClient.ResolveContainerURL(ctx, NameFor(projectID), "agent", Port)
}

// TerminalPod returns the project Pod whose agent container is running,
// provisioning the Pod if it is missing. It does not activate the agent: a
// shell only needs the container, so stopped or failing agents stay reachable.
func (m *Manager) TerminalPod(ctx context.Context, projectID uuid.UUID) (string, error) {
	if pod, ok := m.k8sClient.RunningContainerPod(ctx, NameFor(projectID), "agent"); ok {
		return pod, nil
	}
	if err := m.EnsureProject(ctx, projectID); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	return m.k8sClient.WaitContainerRunning(ctx, NameFor(projectID), "agent")
}

// Exec runs an interactive TTY command in the agent container of pod.
func (m *Manager) Exec(ctx context.Context, req k8s.ExecTTY) error {
	req.Container = "agent"
	return m.k8sClient.Exec(ctx, req)
}

// RunInAgent runs a command in the agent container if it is already running.
// ran is false when there is no running container, so nothing was executed.
func (m *Manager) RunInAgent(ctx context.Context, projectID uuid.UUID, command []string) (out string, ran bool, err error) {
	pod, ok := m.k8sClient.RunningContainerPod(ctx, NameFor(projectID), "agent")
	if !ok {
		return "", false, nil
	}
	out, err = m.k8sClient.Run(ctx, pod, "agent", command)
	return out, true, err
}

// Stop releases agent sessions while keeping the shared project Pod alive.
func (m *Manager) Stop(ctx context.Context, projectID uuid.UUID) error {
	unlock := m.lock(projectID)
	defer unlock()
	if url, ok := m.URL(ctx, projectID); ok {
		stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := m.harnessClient.Stop(stopCtx, url); err != nil {
			return err
		}
		// After Stop, so usage of the runs it aborted is counted too.
		m.release(ctx, projectID)
	}
	return m.store.UpdateSandboxStatus(ctx, projectID, "idle")
}

// Destroy is reserved for project/account deletion, never the Stop agent action.
func (m *Manager) Destroy(ctx context.Context, projectID uuid.UUID) error {
	unlock := m.lock(projectID)
	defer unlock()
	v, _ := m.provisionLocks.LoadOrStore(projectID, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	m.release(ctx, projectID)
	if err := m.k8sClient.StopTask(ctx, NameFor(projectID)); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err := m.k8sClient.DeletePod(ctx, FileMgrPodNameForProject(projectID)); err != nil {
		return err
	}
	return m.k8sClient.DeletePVC(ctx, PVCNameForProjectID(projectID))
}
