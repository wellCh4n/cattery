package k8s

import (
	"context"
	"fmt"
	"strings"
	"time"

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
	OwnerUserID   string
	HarnessImage  string
	ContainerPort int
	Env           map[string]string
	// Sidecars contains additional containers that share a workspace volume
	// (mounted at WorkVolumeMount, default /work) with the harness container.
	Sidecars []SidecarSpec
	// WorkVolumeMount is the path mounted into the harness and all sidecars
	// as the shared workspace. Defaults to "/work" when zero.
	WorkVolumeMount string
}

// SidecarSpec describes one additional container to colocate with the harness.
// The shared workspace volume is automatically mounted at WorkVolumeMount.
type SidecarSpec struct {
	Name          string
	Image         string
	ContainerPort int
	Env           map[string]string
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

	for _, sc := range spec.Sidecars {
		sEnv := make([]interface{}, 0, len(sc.Env))
		for k, v := range sc.Env {
			sEnv = append(sEnv, map[string]interface{}{"name": k, "value": v})
		}
		container := map[string]interface{}{
			"name":         sc.Name,
			"image":        sc.Image,
			"env":          sEnv,
			"volumeMounts": volumeMounts,
		}
		if sc.ContainerPort > 0 {
			container["ports"] = []interface{}{
				map[string]interface{}{"containerPort": int64(sc.ContainerPort)},
			}
		}
		containers = append(containers, container)
	}

	sandbox := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "agents.x-k8s.io/v1alpha1",
			"kind":       "Sandbox",
			"metadata": map[string]interface{}{
				"name":      spec.Name,
				"namespace": c.namespace,
				"labels": map[string]interface{}{
					"cattery-harness-id":    spec.HarnessID,
					"cattery-owner-user-id": spec.OwnerUserID,
				},
			},
			"spec": map[string]interface{}{
				"podTemplate": map[string]interface{}{
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
							map[string]interface{}{
								"name":     workVolumeName,
								"emptyDir": map[string]interface{}{},
							},
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
