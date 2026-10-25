package k8s

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

func testClient() *Client {
	return &Client{namespace: "test", dynamic: fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{podGVR: "PodList", sandboxGVR: "SandboxList"})}
}

func TestSharedProjectSpec(t *testing.T) {
	c := testClient()
	ctx := context.Background()
	spec := SandboxSpec{Name: "project", ProjectID: "id", Image: "pi", ContainerPort: 1114, FileMgrImage: "filemgr", FileMgrPort: 1115, WorkspacePVC: "work"}
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
		if mount["name"] != "workspace" || mount["mountPath"] != "/home/cattery" {
			t.Fatal("workspace not shared")
		}
		if len(mounts) != 1 {
			t.Fatal("sandboxes must not mount the global skill library", name)
		}
		envList, _, _ := unstructured.NestedSlice(container, "env")
		env := map[string]string{}
		for _, item := range envList {
			entry := item.(map[string]interface{})
			env[entry["name"].(string)] = entry["value"].(string)
		}
		if name == "agent" {
			if env["HOME"] != "/home/cattery" || env["WORK_DIR"] != env["HOME"] || container["workingDir"] != env["HOME"] {
				t.Fatal("agent process, tools and shell must share the persisted home", container)
			}
			if _, ok := env["SKILLS_DIR"]; ok {
				t.Fatal("the agent must load skills only from the project")
			}
		} else if env["FILEMGR_ROOT"] != "/home/cattery" {
			t.Fatal("file browser must expose the same persisted home")
		}
	}
	// Sandboxes created with the retired /cattery/global-skills mount keep working.
	mounted := obj.DeepCopy()
	items, _, _ := unstructured.NestedSlice(mounted.Object, "spec", "podTemplate", "spec", "containers")
	agent := items[0].(map[string]interface{})
	agent["volumeMounts"] = append(agent["volumeMounts"].([]interface{}), map[string]interface{}{"name": "skills", "mountPath": "/cattery/global-skills", "readOnly": true})
	if err := unstructured.SetNestedSlice(mounted.Object, items, "spec", "podTemplate", "spec", "containers"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.dynamic.Resource(sandboxGVR).Namespace("test").Update(ctx, mounted, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := c.RunTask(ctx, spec); err != nil {
		t.Fatal("retired global skills mount must stay compatible", err)
	}
	// Old layouts must require migration without deleting the Sandbox or PVCs.
	for _, layout := range []string{"single-container", "work-root", "nested-global-skills"} {
		t.Run(layout, func(t *testing.T) {
			legacy := obj.DeepCopy()
			items, _, _ := unstructured.NestedSlice(legacy.Object, "spec", "podTemplate", "spec", "containers")
			switch layout {
			case "single-container":
				items = items[:1]
			case "work-root":
				for _, item := range items {
					container := item.(map[string]interface{})
					container["volumeMounts"].([]interface{})[0].(map[string]interface{})["mountPath"] = "/work"
				}
			case "nested-global-skills":
				agent := items[0].(map[string]interface{})
				agent["volumeMounts"] = append(agent["volumeMounts"].([]interface{}), map[string]interface{}{"name": "skills", "mountPath": "/home/cattery/.agents/skills", "readOnly": true})
			}
			if err := unstructured.SetNestedSlice(legacy.Object, items, "spec", "podTemplate", "spec", "containers"); err != nil {
				t.Fatal(err)
			}
			if _, err := c.dynamic.Resource(sandboxGVR).Namespace("test").Update(ctx, legacy, metav1.UpdateOptions{}); err != nil {
				t.Fatal(err)
			}
			if err := c.RunTask(ctx, spec); err == nil || !strings.Contains(err.Error(), "keep all workspace and skills PVCs") {
				t.Fatal("legacy spec must require migration", err)
			}
			for _, action := range c.dynamic.(*fake.FakeDynamicClient).Actions() {
				if action.GetVerb() == "delete" {
					t.Fatal("migration must not destroy resources during access")
				}
			}
		})
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
