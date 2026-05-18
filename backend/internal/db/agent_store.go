package db

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

const agentColumns = `agent_id, agent_name, model, prompt, harness_id, repo_url, branch, env_vars, container_port, sandbox_status, task_name, sandbox_url, created_at`

type AgentStore struct{ db *sqlx.DB }

func NewAgentStore(db *sqlx.DB) *AgentStore { return &AgentStore{db} }

func (s *AgentStore) Create(ctx context.Context, a *model.Agent) error {
	env, _ := json.Marshal(a.EnvVars)
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO agents (agent_id, agent_name, model, prompt, harness_id, repo_url, branch, env_vars, container_port)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING created_at`,
		a.AgentID, a.AgentName, a.Model, a.Prompt, a.HarnessID, a.RepoURL, a.Branch, env, a.ContainerPort,
	).Scan(&a.CreatedAt)
}

func (s *AgentStore) GetByID(ctx context.Context, id uuid.UUID) (*model.Agent, error) {
	row := s.db.QueryRowxContext(ctx, `SELECT `+agentColumns+` FROM agents WHERE agent_id=$1`, id)
	return scanAgent(row)
}

func (s *AgentStore) List(ctx context.Context) ([]*model.Agent, error) {
	rows, err := s.db.QueryxContext(ctx, `SELECT `+agentColumns+` FROM agents ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var agents []*model.Agent
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, a)
	}
	return agents, nil
}

func (s *AgentStore) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM agents WHERE agent_id=$1`, id)
	return err
}

func (s *AgentStore) UpdateSandboxStarting(ctx context.Context, id uuid.UUID, taskName string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE agents SET sandbox_status='starting', task_name=$1 WHERE agent_id=$2`,
		taskName, id,
	)
	return err
}

func (s *AgentStore) UpdateSandboxReady(ctx context.Context, id uuid.UUID, sandboxURL string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE agents SET sandbox_status='ready', sandbox_url=$1 WHERE agent_id=$2`,
		sandboxURL, id,
	)
	return err
}

func (s *AgentStore) UpdateSandboxStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE agents SET sandbox_status=$1 WHERE agent_id=$2`,
		status, id,
	)
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanAgent(row scanner) (*model.Agent, error) {
	var a model.Agent
	var envRaw []byte
	if err := row.Scan(
		&a.AgentID, &a.AgentName, &a.Model, &a.Prompt, &a.HarnessID,
		&a.RepoURL, &a.Branch, &envRaw, &a.ContainerPort,
		&a.SandboxStatus, &a.TaskName, &a.SandboxURL, &a.CreatedAt,
	); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(envRaw, &a.EnvVars)
	return &a, nil
}
