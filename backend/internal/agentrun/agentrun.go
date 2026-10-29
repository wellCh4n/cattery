// Package agentrun registers conversations with a project's agent and runs
// prompts in them. Sessions and chat channels are both conversations: a
// session's transcript lives in ~/.cattery/sessions, a channel's (whose id is
// the channel id) in ~/.cattery/channels.
package agentrun

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/wellch4n/cattery/internal/config"
	"github.com/wellch4n/cattery/internal/harness"
)

// Conversation is what the agent needs to know to run one.
type Conversation struct {
	ID        uuid.UUID
	ProjectID uuid.UUID
	Kind      string // harness.KindSession | harness.KindChannel
	Model     string
	Effort    string
}

// ErrUnknownModel means a model id is not in the catalog.
var ErrUnknownModel = errors.New("unknown model")

// ModelGoneError means the conversation's model was removed from the catalog.
type ModelGoneError struct{ Model string }

func (e *ModelGoneError) Error() string {
	return fmt.Sprintf("model %q is no longer configured; switch to another model", e.Model)
}

// UnavailableError means the project's sandbox could not be brought up.
type UnavailableError struct{ Err error }

func (e *UnavailableError) Error() string { return "sandbox unavailable: " + e.Err.Error() }
func (e *UnavailableError) Unwrap() error { return e.Err }

// ResolveModel picks the requested model, or the default when empty. Only
// catalog models are accepted.
func ResolveModel(models *config.Models, id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return models.Default, nil
	}
	if _, ok := models.Get(id); !ok {
		return "", fmt.Errorf("%w %q", ErrUnknownModel, id)
	}
	return id, nil
}

// EffortFor is the effort a conversation on modelID runs at: want when the
// model's provider offers it, else the provider's default. modelID must be in
// the catalog.
func EffortFor(models *config.Models, modelID, want string) string {
	m, _ := models.Get(modelID)
	if m.Provider.HasEffort(want) {
		return want
	}
	return m.Provider.DefaultEffort()
}

// Register registers conv with the agent, along with its model's endpoint and
// key. Idempotent on the agent side (an existing transcript is reopened,
// switching model if it changed), so it's called before every prompt — which
// is also how a model switch reaches the agent. Only sessions get the small
// model, which names them; a channel's name is its title.
func Register(ctx context.Context, client *harness.Client, models *config.Models, sandboxURL string, conv Conversation) error {
	m, ok := models.Get(conv.Model)
	if !ok {
		return &ModelGoneError{conv.Model}
	}
	var small *harness.AgentModel
	if conv.Kind == harness.KindSession {
		if s, ok := models.Get(models.SmallModel); ok {
			small = &harness.AgentModel{
				ID: s.ID, Provider: s.Provider.Type, API: s.Provider.API, BaseURL: s.Provider.Endpoint, APIKey: s.Provider.Key,
			}
		}
	}
	return client.CreateSession(ctx, sandboxURL, conv.ID.String(), conv.Kind, harness.AgentModel{
		ID: m.ID, Provider: m.Provider.Type, API: m.Provider.API, BaseURL: m.Provider.Endpoint, APIKey: m.Provider.Key,
		ThinkingLevel: EffortFor(models, m.ID, conv.Effort),
	}, small)
}

// Sandbox is the part of sandbox.Manager a run needs.
type Sandbox interface {
	Await(context.Context, uuid.UUID) (string, error)
	URL(context.Context, uuid.UUID) (string, bool)
}

// Runner runs prompts outside an HTTP request, for chat channels.
type Runner struct {
	Harness *harness.Client
	Sandbox Sandbox
	Models  *config.Models
}

// Run prompts conv with text and hands every event of the run to handle, up to
// and including its session.idle; started runs once the run has begun. A busy
// conversation takes the text into its running turn instead: Run then returns
// harness.ErrSteered at once, and the run's output keeps going to whoever
// started it.
func (r *Runner) Run(ctx context.Context, conv Conversation, text string, started func(), handle func(*harness.PlatformEvent)) error {
	sandboxURL, err := r.Sandbox.Await(ctx, conv.ProjectID)
	if err != nil {
		return &UnavailableError{err}
	}
	if err := Register(ctx, r.Harness, r.Models, sandboxURL, conv); err != nil {
		return err
	}
	return r.Harness.ConsumeEventsUntilIdle(ctx, sandboxURL, conv.ID.String(), func() error {
		if err := r.Harness.PromptAsync(ctx, sandboxURL, conv.ID.String(), text); err != nil {
			return err
		}
		if started != nil {
			started()
		}
		return nil
	}, handle)
}

// Abort stops conv's run, if its sandbox is up.
func (r *Runner) Abort(ctx context.Context, conv Conversation) error {
	sandboxURL, ok := r.Sandbox.URL(ctx, conv.ProjectID)
	if !ok {
		return nil
	}
	return r.Harness.Abort(ctx, sandboxURL, conv.ID.String())
}

// Answer submits a questionnaire answer (the body pi's questionnaire tool takes).
func (r *Runner) Answer(ctx context.Context, conv Conversation, toolID string, body []byte) error {
	sandboxURL, ok := r.Sandbox.URL(ctx, conv.ProjectID)
	if !ok {
		return errors.New("the sandbox is not running")
	}
	status, message, err := r.Harness.AnswerQuestionnaire(ctx, sandboxURL, conv.ID.String(), toolID, body)
	if err != nil {
		return err
	}
	if status >= 300 {
		if message == "" {
			message = fmt.Sprintf("status %d", status)
		}
		return errors.New(message)
	}
	return nil
}
