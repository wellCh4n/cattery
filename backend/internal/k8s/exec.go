package k8s

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// ExecTTY is an interactive TTY exec request against one container.
type ExecTTY struct {
	Pod       string
	Container string
	Command   []string
	Stdin     io.Reader
	Stdout    io.Writer
	Sizes     remotecommand.TerminalSizeQueue
}

// RunningContainerPod returns the name of the sandbox Pod whose container is
// running. Unlike ResolveContainerURL it ignores readiness: a shell works in an
// agent that is still starting or failing its probe.
func (c *Client) RunningContainerPod(ctx context.Context, name, container string) (string, bool) {
	pods, err := c.dynamic.Resource(podGVR).Namespace(c.namespace).List(ctx, metav1.ListOptions{LabelSelector: LabelInstance + "=" + name + "," + LabelComponent + "=" + ComponentSandbox})
	if err != nil {
		return "", false
	}
	for _, pod := range pods.Items {
		if pod.GetDeletionTimestamp() != nil {
			continue
		}
		statuses, _, _ := unstructured.NestedSlice(pod.Object, "status", "containerStatuses")
		for _, raw := range statuses {
			status, ok := raw.(map[string]interface{})
			if !ok || status["name"] != container {
				continue
			}
			if _, running, _ := unstructured.NestedMap(status, "state", "running"); running {
				return pod.GetName(), true
			}
		}
	}
	return "", false
}

func (c *Client) WaitContainerRunning(ctx context.Context, name, container string) (string, error) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		if pod, ok := c.RunningContainerPod(ctx, name, container); ok {
			return pod, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
		}
	}
}

// Exec streams an interactive TTY session until the command exits or ctx ends.
func (c *Client) Exec(ctx context.Context, req ExecTTY) error {
	exec, err := c.executor(req.Pod, &corev1.PodExecOptions{
		Container: req.Container,
		Command:   req.Command,
		Stdin:     true,
		Stdout:    true,
		TTY:       true,
	})
	if err != nil {
		return err
	}
	return exec.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:             req.Stdin,
		Stdout:            req.Stdout,
		Tty:               true,
		TerminalSizeQueue: req.Sizes,
	})
}

// Run executes a non-interactive command in a container and returns its
// combined output; a non-zero exit is an error.
func (c *Client) Run(ctx context.Context, pod, container string, command []string) (string, error) {
	exec, err := c.executor(pod, &corev1.PodExecOptions{
		Container: container,
		Command:   command,
		Stdout:    true,
		Stderr:    true,
	})
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	err = exec.StreamWithContext(ctx, remotecommand.StreamOptions{Stdout: &out, Stderr: &out})
	return out.String(), err
}

// executor prefers the WebSocket exec protocol and falls back to SPDY, as
// kubectl does.
func (c *Client) executor(pod string, opts *corev1.PodExecOptions) (remotecommand.Executor, error) {
	u := c.clientset.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(c.namespace).Name(pod).SubResource("exec").
		VersionedParams(opts, scheme.ParameterCodec).URL()

	ws, err := remotecommand.NewWebSocketExecutor(c.restConfig, "GET", u.String())
	if err != nil {
		return nil, fmt.Errorf("exec websocket: %w", err)
	}
	spdy, err := remotecommand.NewSPDYExecutor(c.restConfig, "POST", u)
	if err != nil {
		return nil, fmt.Errorf("exec spdy: %w", err)
	}
	return remotecommand.NewFallbackExecutor(ws, spdy, func(err error) bool {
		return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
	})
}
