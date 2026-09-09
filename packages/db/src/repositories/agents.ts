import { newId, NotFoundError, sha256 } from '@ai-engine/shared';
import type { AgentDefinition, AgentVersion } from '@ai-engine/domain';
import type { Queryable } from '../client';
import { camelize, camelizeAll } from '../mapping';

const AGENT_COLUMNS = 'id, type, name, current_version_id, created_at';
const VERSION_COLUMNS = `id, agent_id, version, prompt, prompt_hash, provider, model, model_config,
  tool_policy_version, created_at`;

export class AgentRepository {
  constructor(private readonly db: Queryable) {}

  async ensureAgent(type: AgentDefinition['type'], name: string): Promise<AgentDefinition> {
    const row = await this.db.queryOne(
      `INSERT INTO agents (id, type, name) VALUES ($1, $2, $3)
       ON CONFLICT (type) DO UPDATE SET name = EXCLUDED.name RETURNING ${AGENT_COLUMNS}`,
      [newId(), type, name],
    );
    return camelize<AgentDefinition>(row!);
  }

  async listAgents(): Promise<AgentDefinition[]> {
    return camelizeAll<AgentDefinition>(await this.db.query(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY type ASC`));
  }

  async findByType(type: AgentDefinition['type']): Promise<AgentDefinition | null> {
    const row = await this.db.queryOne(`SELECT ${AGENT_COLUMNS} FROM agents WHERE type = $1`, [type]);
    return row ? camelize<AgentDefinition>(row) : null;
  }

  /**
   * Registers a prompt as a new version only when its hash changed, so every
   * agent run can be traced back to the exact prompt that produced it.
   */
  async registerVersion(input: {
    agentId: string;
    prompt: string;
    provider: string;
    model: string;
    modelConfig: Record<string, unknown>;
    toolPolicyVersion: string;
  }): Promise<AgentVersion> {
    const promptHash = sha256(`${input.prompt}\n${input.provider}\n${input.model}\n${input.toolPolicyVersion}`);
    const existing = await this.db.queryOne(
      `SELECT ${VERSION_COLUMNS} FROM agent_versions WHERE agent_id = $1 AND prompt_hash = $2 ORDER BY version DESC LIMIT 1`,
      [input.agentId, promptHash],
    );
    if (existing) {
      const version = camelize<AgentVersion>(existing);
      await this.db.query('UPDATE agents SET current_version_id = $2 WHERE id = $1', [input.agentId, version.id]);
      return version;
    }
    const next = await this.db.queryOne<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_versions WHERE agent_id = $1',
      [input.agentId],
    );
    const row = await this.db.queryOne(
      `INSERT INTO agent_versions (id, agent_id, version, prompt, prompt_hash, provider, model, model_config, tool_policy_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${VERSION_COLUMNS}`,
      [
        newId(),
        input.agentId,
        next?.next ?? 1,
        input.prompt,
        promptHash,
        input.provider,
        input.model,
        JSON.stringify(input.modelConfig),
        input.toolPolicyVersion,
      ],
    );
    const version = camelize<AgentVersion>(row!);
    await this.db.query('UPDATE agents SET current_version_id = $2 WHERE id = $1', [input.agentId, version.id]);
    return version;
  }

  async getVersion(id: string): Promise<AgentVersion> {
    const row = await this.db.queryOne(`SELECT ${VERSION_COLUMNS} FROM agent_versions WHERE id = $1`, [id]);
    if (!row) throw new NotFoundError('AgentVersion', id);
    return camelize<AgentVersion>(row);
  }

  async getCurrentVersion(type: AgentDefinition['type']): Promise<AgentVersion | null> {
    const row = await this.db.queryOne(
      `SELECT v.id, v.agent_id, v.version, v.prompt, v.prompt_hash, v.provider, v.model, v.model_config,
              v.tool_policy_version, v.created_at
       FROM agent_versions v JOIN agents a ON a.current_version_id = v.id WHERE a.type = $1`,
      [type],
    );
    return row ? camelize<AgentVersion>(row) : null;
  }

  async listVersions(agentId: string): Promise<AgentVersion[]> {
    return camelizeAll<AgentVersion>(
      await this.db.query(`SELECT ${VERSION_COLUMNS} FROM agent_versions WHERE agent_id = $1 ORDER BY version ASC`, [
        agentId,
      ]),
    );
  }
}
