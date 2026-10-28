package live

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

type frame struct {
	Type      string     `json:"type"`
	ProjectID *uuid.UUID `json:"project_id"`
	Data      struct {
		Users         []User `json:"users"`
		SandboxStatus string `json:"sandbox_status"`
	} `json:"data"`
}

func next(t *testing.T, c *Client) frame {
	t.Helper()
	select {
	case raw, ok := <-c.Send:
		if !ok {
			t.Fatal("client closed")
		}
		var f frame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		return f
	default:
		t.Fatal("no frame")
		return frame{}
	}
}

func none(t *testing.T, c *Client) {
	t.Helper()
	select {
	case raw := <-c.Send:
		t.Fatalf("unexpected frame %s", raw)
	default:
	}
}

func names(f frame) []string {
	out := []string{}
	for _, u := range f.Data.Users {
		out = append(out, u.Username)
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPresenceCountsUsersOnceInArrivalOrder(t *testing.T) {
	hub := NewHub()
	project := uuid.New()
	alice := User{UserID: uuid.New(), Username: "alice"}
	bob := User{UserID: uuid.New(), Username: "bob"}

	a1 := hub.Add(alice)
	hub.Subscribe(a1, project)
	if got := names(next(t, a1)); !equal(got, []string{"alice"}) {
		t.Fatalf("presence = %v", got)
	}
	b := hub.Add(bob)
	hub.Subscribe(b, project)
	for _, c := range []*Client{a1, b} {
		if got := names(next(t, c)); !equal(got, []string{"alice", "bob"}) {
			t.Fatalf("presence = %v", got)
		}
	}
	// A second tab of alice's doesn't add her twice.
	a2 := hub.Add(alice)
	hub.Subscribe(a2, project)
	for _, c := range []*Client{a1, b, a2} {
		if got := names(next(t, c)); !equal(got, []string{"alice", "bob"}) {
			t.Fatalf("presence = %v", got)
		}
	}
	// Closing one of her tabs keeps her online.
	hub.Remove(a1)
	for _, c := range []*Client{b, a2} {
		if got := names(next(t, c)); !equal(got, []string{"alice", "bob"}) {
			t.Fatalf("presence = %v", got)
		}
	}
	hub.Unsubscribe(a2, project)
	if got := names(next(t, b)); !equal(got, []string{"bob"}) {
		t.Fatalf("presence = %v", got)
	}
	none(t, a2)
}

func TestPublishReachesOnlySubscribers(t *testing.T) {
	hub := NewHub()
	p1, p2 := uuid.New(), uuid.New()
	in := hub.Add(User{UserID: uuid.New()})
	out := hub.Add(User{UserID: uuid.New()})
	hub.Subscribe(in, p1)
	hub.Subscribe(out, p2)
	next(t, in)
	next(t, out)

	hub.Publish(p1, Event{Type: "sandbox", Data: map[string]string{"sandbox_status": "ready"}})
	f := next(t, in)
	if f.Type != "sandbox" || f.ProjectID == nil || *f.ProjectID != p1 || f.Data.SandboxStatus != "ready" {
		t.Fatalf("frame = %+v", f)
	}
	none(t, out)
}

func TestSlowClientIsDropped(t *testing.T) {
	hub := NewHub()
	project := uuid.New()
	slow := hub.Add(User{UserID: uuid.New()})
	hub.Subscribe(slow, project)
	for range sendBuffer + 1 {
		hub.Publish(project, Event{Type: "sandbox"})
	}
	n := 0
	for range slow.Send {
		n++
	}
	if n != sendBuffer {
		t.Fatalf("got %d frames before close, want %d", n, sendBuffer)
	}
	hub.Remove(slow) // already gone: must not panic
}

func TestEvictUnsubscribesEveryTabOfTheUser(t *testing.T) {
	hub := NewHub()
	project := uuid.New()
	alice := User{UserID: uuid.New(), Username: "alice"}
	bob := User{UserID: uuid.New(), Username: "bob"}
	a1, a2, b := hub.Add(alice), hub.Add(alice), hub.Add(bob)
	for _, c := range []*Client{a1, a2, b} {
		hub.Subscribe(c, project)
	}
	for _, c := range []*Client{a1, a2, b} {
		for len(c.Send) > 0 {
			next(t, c)
		}
	}

	hub.Evict(project, alice.UserID)
	if got := names(next(t, b)); !equal(got, []string{"bob"}) {
		t.Fatalf("presence = %v", got)
	}
	for _, c := range []*Client{a1, a2} {
		if f := next(t, c); f.Type != "removed" || f.ProjectID == nil || *f.ProjectID != project {
			t.Fatalf("frame = %+v", f)
		}
	}
	hub.Publish(project, Event{Type: "terminals"})
	next(t, b)
	none(t, a1)
	none(t, a2)

	var nilHub *Hub
	nilHub.Publish(project, Event{Type: "terminals"})
	nilHub.Evict(project, alice.UserID)
}

func TestOnWatchReportsFirstAndLastSubscriber(t *testing.T) {
	hub := NewHub()
	project := uuid.New()
	var got []bool
	hub.OnWatch(func(p uuid.UUID, watching bool) {
		if p == project {
			got = append(got, watching)
		}
	})
	alice := User{UserID: uuid.New()}
	a1, a2, b := hub.Add(alice), hub.Add(alice), hub.Add(User{UserID: uuid.New()})
	hub.Subscribe(a1, project)
	hub.Subscribe(a2, project)
	hub.Subscribe(b, project)
	hub.Remove(a1)
	hub.Evict(project, alice.UserID)
	hub.Unsubscribe(b, project)
	hub.Subscribe(b, project)
	hub.Remove(b)
	if want := []bool{true, false, true, false}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] || got[3] != want[3] {
		t.Fatalf("watch = %v, want %v", got, want)
	}
}
