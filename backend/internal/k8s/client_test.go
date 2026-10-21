package k8s

import (
	"context"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	"testing"
)

func testClient() *Client {
	return &Client{namespace: "test", dynamic: fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{podGVR: "PodList", sandboxGVR: "SandboxList"})}
}

func TestSharedProjectSpec(t *testing.T) {
	c := testClient()
	ctx := context.Background()
	spec := SandboxSpec{Name: "project", ProjectID: "id", Image: "pi", ContainerPort: 1114, FileMgrImage: "filemgr", FileMgrPort: 1115, WorkspacePVC: "work", SkillsPVC: "skills", SkillsMount: "/skills"}
	if err := c.RunTask(ctx, spec); err != nil {
		t.Fatal(err)
	}
	if err := c.RunTask(ctx, spec); err != nil {
		t.Fatal("not idempotent", err)
	}
	obj, err := c.dynamic.Resource(sandboxGVR).Namespace("test").Get(ctx, "project", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	policy, _, _ := unstructured.NestedString(obj.Object, "spec", "podTemplate", "spec", "restartPolicy")
	if policy != "Always" {
		t.Fatal("containers must restart independently")
	}
	containers, _, _ := unstructured.NestedSlice(obj.Object, "spec", "podTemplate", "spec", "containers")
	if len(containers) != 2 {
		t.Fatal("expected two containers")
	}
	for i, name := range []string{"agent", "filemgr"} {
		container := containers[i].(map[string]interface{})
		if container["name"] != name {
			t.Fatal(container)
		}
		mounts, _, _ := unstructured.NestedSlice(container, "volumeMounts")
		mount := mounts[0].(map[string]interface{})
		if mount["name"] != "workspace" || mount["mountPath"] != "/work" {
			t.Fatal("workspace not shared")
		}
		if name == "filemgr" && len(mounts) != 1 {
			t.Fatal("filemgr should not mount global skills")
		}
	}
	// Legacy resources are never silently accepted or destroyed on a read request.
	unstructured.SetNestedSlice(obj.Object, containers[:1], "spec", "podTemplate", "spec", "containers")
	c.dynamic.Resource(sandboxGVR).Namespace("test").Update(ctx, obj, metav1.UpdateOptions{})
	if err := c.RunTask(ctx, spec); err == nil {
		t.Fatal("legacy spec must require migration")
	}
}

func TestFileServiceReadyWithoutAgent(t *testing.T) {
	c := testClient()
	ctx := context.Background()
	pod := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "v1", "kind": "Pod", "metadata": map[string]interface{}{"name": "shared", "namespace": "test", "labels": commonLabels(ComponentSandbox, "project")},
		"status": map[string]interface{}{"podIP": "10.0.0.2", "containerStatuses": []interface{}{
			map[string]interface{}{"name": "agent", "ready": false}, map[string]interface{}{"name": "filemgr", "ready": true},
		}},
	}}
	if _, err := c.dynamic.Resource(podGVR).Namespace("test").Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if url, ok := c.ResolveContainerURL(ctx, "project", "filemgr", 1115); !ok || url != "http://10.0.0.2:1115" {
		t.Fatal(url, ok)
	}
	if _, ok := c.ResolveContainerURL(ctx, "project", "agent", 1114); ok {
		t.Fatal("unready agent resolved")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := c.WaitContainerReady(cancelled, "project", "agent", 1114); err == nil {
		t.Fatal("cancellation ignored")
	}
}
