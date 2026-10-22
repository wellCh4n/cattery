package k8s

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var sandboxGVR = schema.GroupVersionResource{
	Group:    "agents.x-k8s.io",
	Version:  "v1beta1",
	Resource: "sandboxes",
}

var podGVR = schema.GroupVersionResource{
	Group:    "",
	Version:  "v1",
	Resource: "pods",
}

var pvcGVR = schema.GroupVersionResource{
	Group:    "",
	Version:  "v1",
	Resource: "persistentvolumeclaims",
}

const (
	// K8s-recommended common labels — a uniform selector surface carried by
	// every cattery-managed resource. `app.kubernetes.io/part-of=cattery`
	// selects them all; `.../component=<role>` narrows to one kind.
	LabelName      = "app.kubernetes.io/name"       // always appName
	LabelPartOf    = "app.kubernetes.io/part-of"    // always appName
	LabelManagedBy = "app.kubernetes.io/managed-by" // always managedBy
	LabelComponent = "app.kubernetes.io/component"  // role within the platform
	LabelInstance  = "app.kubernetes.io/instance"   // the resource's own name

	// Business dimensions — custom keys, DNS-subdomain-prefixed per the K8s
	// label conventions (bare/unprefixed keys are reserved for end users).
	LabelProjectID = "cattery.dev/project-id"
)

// Platform-wide constant label values.
const (
	appName   = "cattery"
	managedBy = "cattery-backend"
)

// Component values for LabelComponent — the role a resource plays.
const (
	ComponentSandbox   = "sandbox"
	ComponentFileMgr   = "filemgr"
	ComponentSkillMgr  = "skillmgr"
	ComponentWorkspace = "workspace"
	ComponentSkills    = "skills"
)

// commonLabels returns the app.kubernetes.io/* labels every cattery resource
// carries. component is its role (e.g. ComponentSandbox); instance is the
// resource's own name (omitted when empty).
func commonLabels(component, instance string) map[string]interface{} {
	l := map[string]interface{}{
		LabelName:      appName,
		LabelPartOf:    appName,
		LabelManagedBy: managedBy,
		LabelComponent: component,
	}
	if instance != "" {
		l[LabelInstance] = instance
	}
	return l
}

type Client struct {
	dynamic dynamic.Interface
	// restConfig and clientset back pod exec, which the dynamic client can't do.
	restConfig *rest.Config
	clientset  kubernetes.Interface
	namespace  string
	// storageClass is stamped on every PVC; empty means "cluster default".
	storageClass string
	// pvcAccessMode is the access mode for every PVC (e.g. ReadWriteOnce,
	// ReadWriteMany); empty falls back to ReadWriteMany.
	pvcAccessMode string
}

func NewClient(namespace, storageClass, pvcAccessMode string) (*Client, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		cfg, err = clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
		if err != nil {
			return nil, fmt.Errorf("k8s config: %w", err)
		}
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	if pvcAccessMode == "" {
		pvcAccessMode = "ReadWriteMany"
	}
	return &Client{
		dynamic:       dyn,
		restConfig:    cfg,
		clientset:     cs,
		namespace:     namespace,
		storageClass:  storageClass,
		pvcAccessMode: pvcAccessMode,
	}, nil
}

type SandboxSpec struct {
	Name          string
	ProjectID     string
	Image         string
	ContainerPort int
	FileMgrImage  string
	FileMgrPort   int
	Env           map[string]string
	WorkspacePVC  string
	// WorkVolumeMount is the path the workspace volume is mounted at in the
	// agent and filemgr containers. Defaults to the agent user's home directory
	// when zero, so the project workspace is also `~` inside the Pod.
	WorkVolumeMount string
	// SkillsPVC, when non-empty, mounts the global skills PVC read-only into the
	// agent container at SkillsMount. Empty = no skills volume. The PVC is
	// shared with the skillmgr Pod; on a single node RWO permits both mounts,
	// multi-node needs the PVC reprovisioned as RWX.
	SkillsPVC   string
	SkillsMount string
}

func (c *Client) RunTask(ctx context.Context, spec SandboxSpec) error {
	workMount := spec.WorkVolumeMount
	if workMount == "" {
		workMount = "/home/cattery"
	}
	const workVolumeName = "workspace"

	env := make(map[string]string, len(spec.Env)+3)
	for k, v := range spec.Env {
		env[k] = v
	}
	// Keep the shell, SDK and container process in the same persisted home.
	env["HOME"] = workMount
	env["WORK_DIR"] = workMount
	if spec.SkillsPVC != "" && spec.SkillsMount != "" {
		env["SKILLS_DIR"] = spec.SkillsMount
	}
	envList := make([]interface{}, 0, len(env))
	for k, v := range env {
		envList = append(envList, map[string]interface{}{"name": k, "value": v})
	}

	const skillsVolumeName = "skills"
	mountSkills := spec.SkillsPVC != "" && spec.SkillsMount != ""

	volumeMounts := []interface{}{
		map[string]interface{}{"name": workVolumeName, "mountPath": workMount},
	}
	if mountSkills {
		volumeMounts = append(volumeMounts, map[string]interface{}{
			"name":      skillsVolumeName,
			"mountPath": spec.SkillsMount,
			"readOnly":  true,
		})
	}

	containers := []interface{}{
		map[string]interface{}{
			"name":  "agent",
			"image": spec.Image,
			"ports": []interface{}{
				map[string]interface{}{"containerPort": int64(spec.ContainerPort)},
			},
			"env":          envList,
			"workingDir":   workMount,
			"volumeMounts": volumeMounts,
		},
	}

	containers = append(containers, map[string]interface{}{
		"name": "filemgr", "image": spec.FileMgrImage,
		"ports":        []interface{}{map[string]interface{}{"containerPort": int64(spec.FileMgrPort)}},
		"env":          []interface{}{map[string]interface{}{"name": "FILEMGR_ROOT", "value": workMount}, map[string]interface{}{"name": "PORT", "value": fmt.Sprint(spec.FileMgrPort)}},
		"volumeMounts": []interface{}{map[string]interface{}{"name": workVolumeName, "mountPath": workMount}},
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{"cpu": "50m", "memory": "64Mi"},
			"limits":   map[string]interface{}{"cpu": "1", "memory": "1Gi"},
		},
		"readinessProbe": map[string]interface{}{"httpGet": map[string]interface{}{"path": "/healthz", "port": int64(spec.FileMgrPort)}, "periodSeconds": int64(2)},
	})
	containers[0].(map[string]interface{})["readinessProbe"] = map[string]interface{}{"httpGet": map[string]interface{}{"path": "/session", "port": int64(spec.ContainerPort)}, "periodSeconds": int64(2)}

	labels := commonLabels(ComponentSandbox, spec.Name)
	labels[LabelProjectID] = spec.ProjectID
	workspaceVolume := map[string]interface{}{
		"name":     workVolumeName,
		"emptyDir": map[string]interface{}{},
	}
	if spec.WorkspacePVC != "" {
		workspaceVolume = map[string]interface{}{
			"name": workVolumeName,
			"persistentVolumeClaim": map[string]interface{}{
				"claimName": spec.WorkspacePVC,
			},
		}
	}

	volumes := []interface{}{workspaceVolume}
	if mountSkills {
		volumes = append(volumes, map[string]interface{}{
			"name": skillsVolumeName,
			"persistentVolumeClaim": map[string]interface{}{
				"claimName": spec.SkillsPVC,
				"readOnly":  true,
			},
		})
	}

	sandbox := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "agents.x-k8s.io/v1beta1",
			"kind":       "Sandbox",
			"metadata": map[string]interface{}{
				"name":      spec.Name,
				"namespace": c.namespace,
				"labels":    labels,
			},
			"spec": map[string]interface{}{
				"podTemplate": map[string]interface{}{
					"metadata": map[string]interface{}{
						"labels": labels,
					},
					"spec": map[string]interface{}{
						"restartPolicy": "Always",
						// A short, stable hostname for shell prompts instead of the
						// generated Pod name; nothing resolves Pods by hostname.
						"hostname": "sandbox",
						// The pi image runs as the unprivileged `cattery` user (uid 1000)
						// and needs write access to its persisted home. fsGroup makes
						// K8s chown the volume to gid 1000 so cattery can write.
						"securityContext": map[string]interface{}{
							"fsGroup": int64(1000),
						},
						"volumes":    volumes,
						"containers": containers,
					},
				},
			},
		},
	}

	_, err := c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).Create(ctx, sandbox, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {

		existing, getErr := c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).Get(ctx, spec.Name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		items, _, _ := unstructured.NestedSlice(existing.Object, "spec", "podTemplate", "spec", "containers")
		// Mount changes require Pod recreation. Never silently reuse a legacy
		// layout or destroy running shells and turns during a read request.
		for _, desiredItem := range containers {
			desired := desiredItem.(map[string]interface{})
			compatible := false
			for _, item := range items {
				container, ok := item.(map[string]interface{})
				if !ok || container["name"] != desired["name"] {
					continue
				}
				compatible = hasWorkspaceMounts(container, desired)
				break
			}
			if !compatible {
				return fmt.Errorf("project %s uses a legacy sandbox layout; recreate its Sandbox during deployment to mount the workspace at %s (keep all workspace and skills PVCs; remove any legacy standalone filemgr Pod)", spec.ProjectID, workMount)
			}
		}
		return nil
	}
	return err
}

func hasWorkspaceMounts(container, desired map[string]interface{}) bool {
	mounts, _, _ := unstructured.NestedSlice(container, "volumeMounts")
	wanted, _, _ := unstructured.NestedSlice(desired, "volumeMounts")
	for _, item := range wanted {
		want := item.(map[string]interface{})
		found := false
		for _, item := range mounts {
			mount, ok := item.(map[string]interface{})
			readOnly, _ := mount["readOnly"].(bool)
			wantReadOnly, _ := want["readOnly"].(bool)
			if ok && mount["name"] == want["name"] && mount["mountPath"] == want["mountPath"] && readOnly == wantReadOnly {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// EnsurePVC creates the PVC if absent. Its access mode and storageClassName
// come from Client config (K8S_PVC_ACCESS_MODE / K8S_STORAGE_CLASS); an empty
// storage class is omitted so the cluster's default StorageClass is used.
// component is its role (ComponentWorkspace / ComponentSkills); extra carries
// business dimensions (e.g. LabelProjectID) merged on top of the common
// app.kubernetes.io/* set.
func (c *Client) EnsurePVC(ctx context.Context, name, component string, extra map[string]string) error {
	_, err := c.dynamic.Resource(pvcGVR).Namespace(c.namespace).Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	labels := commonLabels(component, name)
	for k, v := range extra {
		labels[k] = v
	}
	spec := map[string]interface{}{
		"accessModes": []interface{}{c.pvcAccessMode},
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{
				"storage": "10Gi",
			},
		},
	}
	if c.storageClass != "" {
		spec["storageClassName"] = c.storageClass
	}
	pvc := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "PersistentVolumeClaim",
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": c.namespace,
				"labels":    labels,
			},
			"spec": spec,
		},
	}
	_, err = c.dynamic.Resource(pvcGVR).Namespace(c.namespace).Create(ctx, pvc, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func (c *Client) StopTask(ctx context.Context, name string) error {
	policy := metav1.DeletePropagationForeground
	return c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &policy})
}

func (c *Client) ListSandboxes(ctx context.Context) ([]unstructured.Unstructured, error) {
	list, err := c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	return list.Items, nil
}

// SkillMgrPodSpec describes the single, global skillmgr Pod. It mounts the
// global skills PVC and is not tied to any project.
type SkillMgrPodSpec struct {
	Name    string
	PVCName string
	Image   string
	Port    int
}

// EnsureSkillMgrPod creates the global skillmgr Pod with the global skills PVC
// mounted at /skills. Idempotent: returns nil if a Pod with
// the same name already exists. Unlike filemgr there is exactly one of these
// cluster-wide, so it carries no project label.
func (c *Client) EnsureSkillMgrPod(ctx context.Context, spec SkillMgrPodSpec) error {
	if _, err := c.dynamic.Resource(podGVR).Namespace(c.namespace).Get(ctx, spec.Name, metav1.GetOptions{}); err == nil {
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	pod := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "Pod",
			"metadata": map[string]interface{}{
				"name":      spec.Name,
				"namespace": c.namespace,
				"labels":    commonLabels(ComponentSkillMgr, spec.Name),
			},
			"spec": map[string]interface{}{
				"restartPolicy": "Always",
				"securityContext": map[string]interface{}{
					"fsGroup": int64(1000),
				},
				"volumes": []interface{}{
					map[string]interface{}{
						"name": "skills",
						"persistentVolumeClaim": map[string]interface{}{
							"claimName": spec.PVCName,
						},
					},
				},
				"containers": []interface{}{
					map[string]interface{}{
						"name":  "skillmgr",
						"image": spec.Image,
						"ports": []interface{}{
							map[string]interface{}{"containerPort": int64(spec.Port)},
						},
						"env": []interface{}{
							map[string]interface{}{"name": "SKILLMGR_ROOT", "value": "/skills"},
							map[string]interface{}{"name": "PORT", "value": fmt.Sprintf("%d", spec.Port)},
						},
						"volumeMounts": []interface{}{
							map[string]interface{}{"name": "skills", "mountPath": "/skills"},
						},
					},
				},
			},
		},
	}
	_, err := c.dynamic.Resource(podGVR).Namespace(c.namespace).Create(ctx, pod, metav1.CreateOptions{})
	return err
}

// WaitPodReady polls until status.podIP is set and the Ready condition is
// True, then returns the Pod IP. Used for filemgr — sandbox readiness flows
// through the Sandbox CR instead.
func (c *Client) WaitPodReady(ctx context.Context, name string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		obj, err := c.dynamic.Resource(podGVR).Namespace(c.namespace).Get(ctx, name, metav1.GetOptions{})
		if err == nil {
			ip, _, _ := unstructured.NestedString(obj.Object, "status", "podIP")
			ready := false
			conditions, _, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
			for _, raw := range conditions {
				cond, ok := raw.(map[string]interface{})
				if !ok {
					continue
				}
				if cond["type"] == "Ready" && cond["status"] == "True" {
					ready = true
					break
				}
			}
			if ip != "" && ready {
				return ip, nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return "", fmt.Errorf("timeout waiting for pod %s", name)
}

// DeletePod removes the named Pod. A NotFound is treated as success so
// callers can use it for idempotent cleanup.
func (c *Client) DeletePod(ctx context.Context, name string) error {
	err := c.dynamic.Resource(podGVR).Namespace(c.namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

// DeletePVC removes the named PersistentVolumeClaim. NotFound = success.
// Cleanup of the bound PersistentVolume is left to the storage class's
// reclaim policy (typically Delete for dynamic provisioning).
func (c *Client) DeletePVC(ctx context.Context, name string) error {
	err := c.dynamic.Resource(pvcGVR).Namespace(c.namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

// ResolveContainerURL checks only the requested container, so a restarting agent
// does not make the healthy file manager unavailable.
func (c *Client) ResolveContainerURL(ctx context.Context, name, container string, port int) (string, bool) {
	pods, err := c.dynamic.Resource(podGVR).Namespace(c.namespace).List(ctx, metav1.ListOptions{LabelSelector: LabelInstance + "=" + name + "," + LabelComponent + "=" + ComponentSandbox})
	if err != nil {
		return "", false
	}
	for _, pod := range pods.Items {
		if pod.GetDeletionTimestamp() != nil {
			continue
		}
		ip, _, _ := unstructured.NestedString(pod.Object, "status", "podIP")
		if ip == "" {
			continue
		}
		statuses, _, _ := unstructured.NestedSlice(pod.Object, "status", "containerStatuses")
		for _, raw := range statuses {
			status, ok := raw.(map[string]interface{})
			if ok && status["name"] == container && status["ready"] == true {
				return "http://" + net.JoinHostPort(ip, strconv.Itoa(port)), true
			}
		}
	}
	return "", false
}

func (c *Client) WaitContainerReady(ctx context.Context, name, container string, port int) (string, error) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		if url, ok := c.ResolveContainerURL(ctx, name, container, port); ok {
			return url, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
		}
	}
}
