package k8s

import (
	"context"
	"fmt"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var sandboxGVR = schema.GroupVersionResource{
	Group:    "agents.x-k8s.io",
	Version:  "v1alpha1",
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
	LabelHarnessID = "cattery.harness.id"
	LabelProjectID = "cattery.project.id"
	LabelComponent = "cattery.component"
)

type Client struct {
	dynamic   dynamic.Interface
	namespace string
}

func NewClient(namespace string) (*Client, error) {
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
	return &Client{dynamic: dyn, namespace: namespace}, nil
}

type SandboxSpec struct {
	Name          string
	SessionID     string
	HarnessID     string
	ProjectID     string
	HarnessImage  string
	ContainerPort int
	Env           map[string]string
	WorkspacePVC  string
	// WorkVolumeMount is the path the workspace volume is mounted at in the
	// harness container. Defaults to "/work" when zero.
	WorkVolumeMount string
}

func (c *Client) RunTask(ctx context.Context, spec SandboxSpec) error {
	workMount := spec.WorkVolumeMount
	if workMount == "" {
		workMount = "/work"
	}
	const workVolumeName = "workspace"

	envList := make([]interface{}, 0, len(spec.Env))
	for k, v := range spec.Env {
		envList = append(envList, map[string]interface{}{"name": k, "value": v})
	}

	volumeMounts := []interface{}{
		map[string]interface{}{"name": workVolumeName, "mountPath": workMount},
	}

	containers := []interface{}{
		map[string]interface{}{
			"name":  "harness",
			"image": spec.HarnessImage,
			"ports": []interface{}{
				map[string]interface{}{"containerPort": int64(spec.ContainerPort)},
			},
			"env":          envList,
			"volumeMounts": volumeMounts,
		},
	}

	labels := map[string]interface{}{
		LabelHarnessID: spec.HarnessID,
		LabelProjectID: spec.ProjectID,
	}
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

	sandbox := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "agents.x-k8s.io/v1alpha1",
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
						"restartPolicy": "Never",
						// emptyDir defaults to root:root, but claude-code / codex / hermes
						// run as the unprivileged `node` user (uid 1000) and need write
						// access to /work. fsGroup makes K8s chown the volume to gid 1000
						// so node can write; opencode (root) ignores ownership anyway.
						"securityContext": map[string]interface{}{
							"fsGroup": int64(1000),
						},
						"volumes": []interface{}{
							workspaceVolume,
						},
						"containers": containers,
					},
				},
			},
		},
	}

	_, err := c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).Create(ctx, sandbox, metav1.CreateOptions{})
	return err
}

func (c *Client) EnsurePVC(ctx context.Context, name string, labels map[string]string) error {
	_, err := c.dynamic.Resource(pvcGVR).Namespace(c.namespace).Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	metaLabels := map[string]interface{}{}
	for k, v := range labels {
		metaLabels[k] = v
	}
	pvc := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "PersistentVolumeClaim",
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": c.namespace,
				"labels":    metaLabels,
			},
			"spec": map[string]interface{}{
				"accessModes": []interface{}{"ReadWriteOnce"},
				"resources": map[string]interface{}{
					"requests": map[string]interface{}{
						"storage": "10Gi",
					},
				},
			},
		},
	}
	_, err = c.dynamic.Resource(pvcGVR).Namespace(c.namespace).Create(ctx, pvc, metav1.CreateOptions{})
	return err
}

func (c *Client) WaitReady(ctx context.Context, name string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		obj, err := c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			time.Sleep(500 * time.Millisecond)
			continue
		}

		conditions, _, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
		for _, raw := range conditions {
			cond, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			if cond["type"] == "Ready" && cond["status"] == "True" {
				port := containerPort(obj.Object)
				if url, ok := urlFromStatusPodIPs(obj.Object, port); ok {
					return url, nil
				}
				if url, ok := c.urlFromSelectedPod(ctx, obj.Object, port); ok {
					return url, nil
				}
			}
		}

		time.Sleep(500 * time.Millisecond)
	}
	return "", fmt.Errorf("timeout waiting for sandbox %s", name)
}

func urlFromStatusPodIPs(obj map[string]interface{}, port int64) (string, bool) {
	podIPs, _, _ := unstructured.NestedStringSlice(obj, "status", "podIPs")
	for _, ip := range podIPs {
		if ip != "" && !strings.Contains(ip, ":") {
			return fmt.Sprintf("http://%s:%d", ip, port), true
		}
	}
	return "", false
}

func (c *Client) urlFromSelectedPod(ctx context.Context, obj map[string]interface{}, port int64) (string, bool) {
	selector, _, _ := unstructured.NestedString(obj, "status", "selector")
	if selector == "" {
		return "", false
	}
	pods, err := c.dynamic.Resource(podGVR).Namespace(c.namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return "", false
	}
	for _, pod := range pods.Items {
		ip, _, _ := unstructured.NestedString(pod.Object, "status", "podIP")
		if ip != "" && !strings.Contains(ip, ":") {
			return fmt.Sprintf("http://%s:%d", ip, port), true
		}
	}
	return "", false
}

func containerPort(obj map[string]interface{}) int64 {
	containers, _, _ := unstructured.NestedSlice(obj, "spec", "podTemplate", "spec", "containers")
	if len(containers) > 0 {
		if c, ok := containers[0].(map[string]interface{}); ok {
			ports, _, _ := unstructured.NestedSlice(c, "ports")
			if len(ports) > 0 {
				if p, ok := ports[0].(map[string]interface{}); ok {
					if v, ok := p["containerPort"].(int64); ok {
						return v
					}
				}
			}
		}
	}
	return 1114
}

func (c *Client) StopTask(ctx context.Context, name string) error {
	return c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func (c *Client) ListSandboxes(ctx context.Context) ([]unstructured.Unstructured, error) {
	list, err := c.dynamic.Resource(sandboxGVR).Namespace(c.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	return list.Items, nil
}

// FileMgrPodSpec describes the filemgr Pod that lives once per project and
// exposes /list /read /upload etc. over the project's workspace PVC.
type FileMgrPodSpec struct {
	Name      string
	ProjectID string
	PVCName   string
	Image     string
	Port      int
}

// EnsureFileMgrPod creates a bare Pod running the filemgr image with the
// project PVC mounted at /work. Idempotent: if a Pod with the same name
// already exists, returns nil without re-creating.
func (c *Client) EnsureFileMgrPod(ctx context.Context, spec FileMgrPodSpec) error {
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
				"labels": map[string]interface{}{
					LabelProjectID: spec.ProjectID,
					LabelComponent: "filemgr",
				},
			},
			"spec": map[string]interface{}{
				// Always-restart so a crashed filemgr comes back without
				// operator intervention. Node loss still drops the Pod —
				// upgrade to a Deployment if that matters later.
				"restartPolicy": "Always",
				"securityContext": map[string]interface{}{
					"fsGroup": int64(1000),
				},
				"volumes": []interface{}{
					map[string]interface{}{
						"name": "workspace",
						"persistentVolumeClaim": map[string]interface{}{
							"claimName": spec.PVCName,
						},
					},
				},
				"containers": []interface{}{
					map[string]interface{}{
						"name":  "filemgr",
						"image": spec.Image,
						"ports": []interface{}{
							map[string]interface{}{"containerPort": int64(spec.Port)},
						},
						"env": []interface{}{
							map[string]interface{}{"name": "FILEMGR_ROOT", "value": "/work"},
							map[string]interface{}{"name": "PORT", "value": fmt.Sprintf("%d", spec.Port)},
						},
						"volumeMounts": []interface{}{
							map[string]interface{}{"name": "workspace", "mountPath": "/work"},
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
