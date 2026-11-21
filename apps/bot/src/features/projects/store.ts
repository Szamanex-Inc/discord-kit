import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { migrate, type Migration } from '../../db.ts';
import { MAX_LINKS } from './links.ts';

export interface Project {
  id: number;
  /** Ticket key prefix, 2–6 uppercase letters, e.g. DK. */
  key: string;
  name: string;
  /** Name of the status template from the preset. */
  template: string;
  visibility: 'private' | 'public';
  categoryId: string;
  forumId: string;
  boardId: string;
  activityId: string;
  roleId: string;
  /** Status key → id of the bot's message for that status in #board. */
  boardMessageIds: Record<string, string>;
  createdBy: string;
  createdAt: string;
}

export interface ProjectRepo {
  owner: string;
  name: string;
  isDefault: boolean;
}

export interface Ticket {
  id: number;
  projectId: number;
  /** Number within the project; never reused. */
  number: number;
  /** Project key and number, e.g. DK-12. */
  key: string;
  title: string;
  body: string;
  /** Status key from the project's template. */
  status: string;
  threadId: string | null;
  /** The bot's message with the ticket's controls (the starter message of bot-created posts). */
  controlMessageId: string | null;
  deleted: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** User ids, in the order they were added. */
  assignees: string[];
  /** The linked GitHub issue, if any. */
  issue: { owner: string; name: string; number: number } | null;
  /**
   * Assignees of the linked issue whose GitHub login matches no `/profile`, as of the last sync.
   * They can't be assigned in Discord, so the control message lists them instead.
   */
  unlinkedGithubLogins: string[];
  /** Whether the stored description replaces the text of a manually created post. */
  bodyEdited: boolean;
}

type IssueClosure = NonNullable<Ticket['issue']> & {
  ticketId: number;
  ticketKey: string;
  projectId: number;
};

/** Where a change came from. Later milestones add e.g. github, agent, scheduler. */
export type TicketEventSource =
  'button' | 'command' | 'tag-edit' | 'title-edit' | 'reconcile' | 'system' | 'github';
export type TicketEventType =
  'created' | 'status' | 'title' | 'description' | 'assigned' | 'unassigned' | 'deleted';

export interface TicketEvent {
  id: number;
  type: TicketEventType;
  fromValue: string | null;
  toValue: string | null;
  actor: string;
  source: TicketEventSource;
  at: string;
}

const TICKET_SELECT = `SELECT t.*, p.key || '-' || t.number AS ticket_key
  FROM tickets t JOIN projects p ON p.id = t.project_id`;

/**
 * Version 1 creates every table of the projects feature. Tickets, assignees, links (GitHub, used
 * from milestone 2) and the change history live here too, so the module owns all its tables.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        template TEXT NOT NULL,
        visibility TEXT NOT NULL,
        category_id TEXT NOT NULL,
        forum_id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        board_message_ids TEXT NOT NULL DEFAULT '{}',
        next_number INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE project_repos (
        project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        PRIMARY KEY (project_id, owner, name)
      );
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        thread_id TEXT,
        control_message_id TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, number)
      );
      CREATE INDEX tickets_status ON tickets (project_id, status);
      CREATE INDEX tickets_thread ON tickets (thread_id);
      CREATE TABLE ticket_assignees (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (ticket_id, user_id)
      );
      CREATE TABLE ticket_links (
        ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        PRIMARY KEY (ticket_id, owner, name, issue_number)
      );
      CREATE TABLE ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        from_value TEXT,
        to_value TEXT,
        actor_user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX ticket_events_ticket ON ticket_events (ticket_id, id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE project_links (
        project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        url TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (project_id, name)
      );
    `,
  },
  {
    version: 3,
    // Linked issue assignees that match no profile (a JSON array of GitHub logins).
    sql: `ALTER TABLE tickets ADD COLUMN unlinked_github_logins TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    version: 4,
    sql: 'ALTER TABLE tickets ADD COLUMN body_edited INTEGER NOT NULL DEFAULT 0;',
  },
];

const ISSUE_CLOSURE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE deleted_ticket_issues (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets (id) ON DELETE CASCADE,
        owner TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL COLLATE NOCASE,
        issue_number INTEGER NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX deleted_ticket_issues_ref ON deleted_ticket_issues (owner, name, issue_number);
    `,
  },
];

/** Projects, their repos and (from the tickets module) tickets with their history. */
export class ProjectsStore {
  constructor(protected readonly db: DatabaseSync) {
    migrate(db, 'projects', MIGRATIONS);
    migrate(db, 'project_issue_closures', ISSUE_CLOSURE_MIGRATIONS);
  }

  createProject(p: Omit<Project, 'id' | 'createdAt' | 'boardMessageIds'>): Project {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO projects (key, name, template, visibility, category_id, forum_id, board_id, activity_id,
           role_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.key,
        p.name,
        p.template,
        p.visibility,
        p.categoryId,
        p.forumId,
        p.boardId,
        p.activityId,
        p.roleId,
        p.createdBy,
        createdAt,
      );
    return { ...p, id: Number(result.lastInsertRowid), boardMessageIds: {}, createdAt };
  }

  project(id: number): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? toProject(row) : undefined;
  }

  projectByKey(key: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE key = ?').get(key);
    return row ? toProject(row) : undefined;
  }

  /** The project owning a category, forum, board or activity channel. */
  projectByChannel(channelId: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE ? IN (category_id, forum_id, board_id, activity_id)')
      .get(channelId);
    return row ? toProject(row) : undefined;
  }

  projects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all().map(toProject);
  }

  setBoardMessageIds(projectId: number, ids: Record<string, string>): void {
    this.db
      .prepare('UPDATE projects SET board_message_ids = ? WHERE id = ?')
      .run(JSON.stringify(ids), projectId);
  }

  repos(projectId: number): ProjectRepo[] {
    return this.db
      .prepare('SELECT owner, name, is_default FROM project_repos WHERE project_id = ? ORDER BY position')
      .all(projectId)
      .map((r) => ({ owner: String(r.owner), name: String(r.name), isDefault: r.is_default === 1 }));
  }

  defaultRepo(projectId: number): ProjectRepo | undefined {
    const repos = this.repos(projectId);
    return repos.find((repo) => repo.isDefault) ?? repos[0];
  }

  /** Adds a repo; the first repo of a project becomes its default. Adding an existing repo does nothing. */
  addRepo(projectId: number, owner: string, name: string): void {
    const count = Number(
      this.db.prepare('SELECT COUNT(*) AS n FROM project_repos WHERE project_id = ?').get(projectId)?.n ?? 0,
    );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_repos (project_id, owner, name, is_default, position)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, owner, name, count === 0 ? 1 : 0, count);
  }

  removeRepo(projectId: number, owner: string, name: string): boolean {
    const result = this.db
      .prepare('DELETE FROM project_repos WHERE project_id = ? AND owner = ? AND name = ?')
      .run(projectId, owner, name);
    return Number(result.changes) === 1;
  }

  /** The project a repo belongs to (case-insensitive); a repo can be in one project only. */
  projectByRepo(owner: string, name: string): Project | undefined {
    const row = this.db
      .prepare(
        `SELECT p.* FROM projects p JOIN project_repos r ON r.project_id = p.id
         WHERE r.owner = ? COLLATE NOCASE AND r.name = ? COLLATE NOCASE`,
      )
      .get(owner, name);
    return row ? toProject(row) : undefined;
  }

  setDefaultRepo(projectId: number, owner: string, name: string): boolean {
    if (!this.repos(projectId).some((r) => r.owner === owner && r.name === name)) return false;
    this.db
      .prepare('UPDATE project_repos SET is_default = (owner = ? AND name = ?) WHERE project_id = ?')
      .run(owner, name, projectId);
    return true;
  }
  // ---- Links ----

  links(projectId: number): { name: string; url: string }[] {
    return this.db
      .prepare('SELECT name, url FROM project_links WHERE project_id = ? ORDER BY position')
      .all(projectId)
      .map((r) => ({ name: String(r.name), url: String(r.url) }));
  }

  /** Adds a named link; names are unique per project (case-insensitive), at most MAX_LINKS. */
  addLink(projectId: number, name: string, url: string): 'added' | 'exists' | 'full' {
    const links = this.links(projectId);
    if (links.some((l) => l.name.toLowerCase() === name.toLowerCase())) return 'exists';
    if (links.length >= MAX_LINKS) return 'full';
    const position = Number(
      this.db
        .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM project_links WHERE project_id = ?')
        .get(projectId)?.p ?? 0,
    );
    this.db
      .prepare('INSERT INTO project_links (project_id, name, url, position) VALUES (?, ?, ?, ?)')
      .run(projectId, name, url, position);
    return 'added';
  }

  removeLink(projectId: number, name: string): boolean {
    const result = this.db
      .prepare('DELETE FROM project_links WHERE project_id = ? AND name = ?')
      .run(projectId, name);
    return Number(result.changes) === 1;
  }

  // ---- Tickets ----

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private log(
    ticketId: number,
    type: TicketEventType,
    from: string | null,
    to: string | null,
    actor: string,
    source: TicketEventSource,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ticket_events (ticket_id, type, from_value, to_value, actor_user_id, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ticketId, type, from, to, actor, source, new Date().toISOString());
  }

  private touch(ticketId: number): void {
    this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), ticketId);
  }

  private toTicket(row: Record<string, SQLOutputValue>): Ticket {
    const assignees = this.db
      .prepare('SELECT user_id FROM ticket_assignees WHERE ticket_id = ? ORDER BY rowid')
      .all(Number(row.id))
      .map((r) => String(r.user_id));
    const link = this.issueOf(Number(row.id));
    return {
      id: Number(row.id),
      projectId: Number(row.project_id),
      number: Number(row.number),
      key: String(row.ticket_key),
      title: String(row.title),
      body: String(row.body),
      status: String(row.status),
      threadId: row.thread_id == null ? null : String(row.thread_id),
      controlMessageId: row.control_message_id == null ? null : String(row.control_message_id),
      deleted: row.deleted === 1,
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      assignees,
      issue: link ?? null,
      unlinkedGithubLogins: JSON.parse(String(row.unlinked_github_logins ?? '[]')) as string[],
      bodyEdited: Boolean(row.body_edited),
    };
  }

  /** Creates a ticket with the project's next number (numbers are never reused). */
  createTicket(
    projectId: number,
    t: { title: string; body: string; status: string; createdBy: string },
    source: TicketEventSource,
  ): Ticket {
    return this.tx(() => {
      const row = this.db
        .prepare(
          'UPDATE projects SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS n',
        )
        .get(projectId);
      if (!row) throw new Error(`project ${projectId} not found`);
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO tickets (project_id, number, title, body, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, Number(row.n), t.title, t.body, t.status, t.createdBy, now, now);
      const id = Number(result.lastInsertRowid);
      this.log(id, 'created', null, t.status, t.createdBy, source);
      return this.ticket(id)!;
    });
  }

  ticket(id: number): Ticket | undefined {
    const row = this.db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id);
    return row ? this.toTicket(row) : undefined;
  }

  /** A ticket by its key, e.g. DK-12 (case-insensitive). */
  ticketByKey(key: string): Ticket | undefined {
    const m = /^([a-z]{2,6})-(\d+)$/i.exec(key.trim());
    if (!m) return undefined;
    const row = this.db.prepare(`${TICKET_SELECT} WHERE p.key = ? AND t.number = ?`).get(m[1]!, Number(m[2]));
    return row ? this.toTicket(row) : undefined;
  }

  ticketByThread(threadId: string): Ticket | undefined {
    const row = this.db.prepare(`${TICKET_SELECT} WHERE t.thread_id = ?`).get(threadId);
    return row ? this.toTicket(row) : undefined;
  }

  tickets(
    projectId: number,
    filter: { status?: string; assignee?: string; includeDeleted?: boolean } = {},
  ): Ticket[] {
    const where = ['t.project_id = ?'];
    const params: (string | number)[] = [projectId];
    if (!filter.includeDeleted) where.push('t.deleted = 0');
    if (filter.status) {
      where.push('t.status = ?');
      params.push(filter.status);
    }
    if (filter.assignee) {
      where.push('EXISTS (SELECT 1 FROM ticket_assignees a WHERE a.ticket_id = t.id AND a.user_id = ?)');
      params.push(filter.assignee);
    }
    return this.db
      .prepare(`${TICKET_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.number`)
      .all(...params)
      .map((r) => this.toTicket(r));
  }

  /** Tickets in any project the user is assigned to (not deleted). */
  ticketsAssignedTo(userId: string): Ticket[] {
    return this.db
      .prepare(
        `${TICKET_SELECT} JOIN ticket_assignees a ON a.ticket_id = t.id
         WHERE a.user_id = ? AND t.deleted = 0 ORDER BY p.key, t.number`,
      )
      .all(userId)
      .map((r) => this.toTicket(r));
  }

  attachThread(ticketId: number, threadId: string, controlMessageId: string): void {
    this.db
      .prepare('UPDATE tickets SET thread_id = ?, control_message_id = ? WHERE id = ?')
      .run(threadId, controlMessageId, ticketId);
  }

  /** Changes the status; undefined (and nothing logged) when it is already that status. */
  setStatus(ticketId: number, status: string, actor: string, source: TicketEventSource): Ticket | undefined {
    return this.tx(() => {
      const current = this.ticket(ticketId);
      if (!current || current.status === status) return undefined;
      this.db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, ticketId);
      this.touch(ticketId);
      this.log(ticketId, 'status', current.status, status, actor, source);
      return this.ticket(ticketId);
    });
  }

  setTitle(ticketId: number, title: string, actor: string, source: TicketEventSource): Ticket | undefined {
    return this.tx(() => {
      const current = this.ticket(ticketId);
      if (!current || current.title === title) return undefined;
      this.db.prepare('UPDATE tickets SET title = ? WHERE id = ?').run(title, ticketId);
      this.touch(ticketId);
      this.log(ticketId, 'title', current.title, title, actor, source);
      return this.ticket(ticketId);
    });
  }

  /** Saves the form as one edit, recording only the fields that changed. */
  editTicket(ticketId: number, title: string, body: string, actor: string): Ticket | undefined {
    return this.tx(() => {
      const current = this.ticket(ticketId);
      if (!current || current.deleted || (current.title === title && current.body === body)) return undefined;
      const bodyChanged = current.body !== body;
      this.db
        .prepare('UPDATE tickets SET title = ?, body = ?, body_edited = ? WHERE id = ?')
        .run(title, body, Number(current.bodyEdited || bodyChanged), ticketId);
      this.touch(ticketId);
      if (current.title !== title) this.log(ticketId, 'title', current.title, title, actor, 'command');
      if (bodyChanged) this.log(ticketId, 'description', null, null, actor, 'command');
      return this.ticket(ticketId);
    });
  }

  addAssignee(ticketId: number, userId: string, actor: string, source: TicketEventSource): boolean {
    return this.tx(() => {
      const result = this.db
        .prepare('INSERT OR IGNORE INTO ticket_assignees (ticket_id, user_id, added_at) VALUES (?, ?, ?)')
        .run(ticketId, userId, new Date().toISOString());
      if (Number(result.changes) !== 1) return false;
      this.touch(ticketId);
      this.log(ticketId, 'assigned', null, userId, actor, source);
      return true;
    });
  }

  removeAssignee(ticketId: number, userId: string, actor: string, source: TicketEventSource): boolean {
    return this.tx(() => {
      const result = this.db
        .prepare('DELETE FROM ticket_assignees WHERE ticket_id = ? AND user_id = ?')
        .run(ticketId, userId);
      if (Number(result.changes) !== 1) return false;
      this.touch(ticketId);
      this.log(ticketId, 'unassigned', userId, null, actor, source);
      return true;
    });
  }

  /** Soft deletes the ticket and records any GitHub issue linked at the time of deletion. */
  markDeleted(ticketId: number, actor: string, source: TicketEventSource): boolean {
    return this.tx(() => {
      const result = this.db
        .prepare('UPDATE tickets SET deleted = 1 WHERE id = ? AND deleted = 0')
        .run(ticketId);
      if (Number(result.changes) !== 1) return false;
      this.recordIssueClosure(ticketId);
      this.touch(ticketId);
      this.log(ticketId, 'deleted', null, null, actor, source);
      return true;
    });
  }

  private recordIssueClosure(ticketId: number): void {
    this.db
      .prepare(
        `INSERT INTO deleted_ticket_issues (ticket_id, owner, name, issue_number)
         SELECT ticket_id, owner, name, issue_number FROM ticket_links WHERE ticket_id = ?`,
      )
      .run(ticketId);
  }

  pendingIssueClosures(projectId?: number): IssueClosure[] {
    return this.db
      .prepare(
        `SELECT d.*, t.project_id, p.key || '-' || t.number AS ticket_key
         FROM deleted_ticket_issues d JOIN tickets t ON t.id = d.ticket_id
         JOIN projects p ON p.id = t.project_id
         WHERE d.finished = 0 AND (? IS NULL OR t.project_id = ?)`,
      )
      .all(projectId ?? null, projectId ?? null)
      .map((row) => ({
        ticketId: Number(row.ticket_id),
        ticketKey: String(row.ticket_key),
        projectId: Number(row.project_id),
        owner: String(row.owner),
        name: String(row.name),
        number: Number(row.issue_number),
      }));
  }

  isIssueClosurePending(ticketId: number): boolean {
    return this.hasIssueClosure(ticketId, true);
  }

  private hasIssueClosure(ticketId: number, pendingOnly = false): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM deleted_ticket_issues WHERE ticket_id = ? AND (? = 0 OR finished = 0)')
        .get(ticketId, Number(pendingOnly)),
    );
  }

  finishIssueClosure(ticketId: number): void {
    this.db.prepare('UPDATE deleted_ticket_issues SET finished = 1 WHERE ticket_id = ?').run(ticketId);
  }

  /** Avoid recreating a deleted ticket automatically, even if someone later reopens the issue. */
  wasLinkedToDeletedTicket(
    projectId: number,
    owner: string,
    name: string,
    number: number,
    pendingOnly = false,
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM deleted_ticket_issues d JOIN tickets t ON t.id = d.ticket_id
           WHERE t.project_id = ? AND d.owner = ? AND d.name = ?
           AND d.issue_number = ? AND (? = 0 OR d.finished = 0)`,
        )
        .get(projectId, owner, name, number, Number(pendingOnly)),
    );
  }

  /** The status a ticket had right before it last moved to `status` (Unblock returns there). */
  statusBefore(ticketId: number, status: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT from_value FROM ticket_events WHERE ticket_id = ? AND type = 'status' AND to_value = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(ticketId, status);
    return row?.from_value == null ? undefined : String(row.from_value);
  }

  // ---- GitHub links ----

  /** Links a ticket to an issue (replacing any earlier link and its unmatched assignees). */
  linkIssue(ticketId: number, owner: string, name: string, number: number): void {
    this.tx(() => this.replaceIssueLink(ticketId, owner, name, number));
  }

  /**
   * Records the issue the bot created for a previously unlinked, active ticket. If the ticket was
   * deleted while GitHub was creating it, keep the new link and queue the issue for closure.
   */
  linkCreatedIssue(
    ticketId: number,
    owner: string,
    name: string,
    number: number,
  ): 'linked' | 'queued' | 'ignored' {
    return this.tx(() => {
      const ticket = this.ticket(ticketId);
      if (!ticket || ticket.issue || this.hasIssueClosure(ticketId)) return 'ignored';
      this.replaceIssueLink(ticketId, owner, name, number);
      if (!ticket.deleted) return 'linked';
      this.recordIssueClosure(ticketId);
      return 'queued';
    });
  }

  private replaceIssueLink(ticketId: number, owner: string, name: string, number: number): void {
    this.db.prepare('DELETE FROM ticket_links WHERE ticket_id = ?').run(ticketId);
    this.setUnlinkedGithubLogins(ticketId, []);
    this.db
      .prepare(
        `INSERT INTO ticket_links (ticket_id, project_id, owner, name, issue_number)
         SELECT id, project_id, ?, ?, ? FROM tickets WHERE id = ?`,
      )
      .run(owner, name, number, ticketId);
  }

  unlinkIssue(ticketId: number): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM ticket_links WHERE ticket_id = ?').run(ticketId);
      this.setUnlinkedGithubLogins(ticketId, []);
    });
  }

  /**
   * Remembers the linked issue's assignees that match no profile. Not a ticket change, so nothing
   * is logged. Returns whether the list changed.
   */
  setUnlinkedGithubLogins(ticketId: number, logins: string[]): boolean {
    const current = this.db
      .prepare('SELECT unlinked_github_logins AS l FROM tickets WHERE id = ?')
      .get(ticketId)?.l;
    const next = JSON.stringify(logins);
    if (current == null || String(current) === next) return false;
    this.db.prepare('UPDATE tickets SET unlinked_github_logins = ? WHERE id = ?').run(next, ticketId);
    return true;
  }

  issueOf(ticketId: number): { owner: string; name: string; number: number } | undefined {
    const row = this.db
      .prepare('SELECT owner, name, issue_number FROM ticket_links WHERE ticket_id = ? LIMIT 1')
      .get(ticketId);
    return row
      ? { owner: String(row.owner), name: String(row.name), number: Number(row.issue_number) }
      : undefined;
  }

  /** The (not deleted) ticket linked to an issue; the repo is matched case-insensitively. */
  ticketByIssue(owner: string, name: string, number: number): Ticket | undefined {
    const row = this.db
      .prepare(
        `${TICKET_SELECT} JOIN ticket_links l ON l.ticket_id = t.id
         WHERE l.owner = ? COLLATE NOCASE AND l.name = ? COLLATE NOCASE AND l.issue_number = ? AND t.deleted = 0`,
      )
      .get(owner, name, number);
    return row ? this.toTicket(row) : undefined;
  }

  /** When the ticket last changed from Discord in a way that could affect GitHub sync. */
  lastLocalChangeAt(ticketId: number): string | undefined {
    const row = this.db
      .prepare(
        "SELECT MAX(at) AS at FROM ticket_events WHERE ticket_id = ? AND source != 'github' AND type != 'description'",
      )
      .get(ticketId);
    return row?.at == null ? undefined : String(row.at);
  }

  /** The ticket's history, oldest first. */
  events(ticketId: number): TicketEvent[] {
    return this.db
      .prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id')
      .all(ticketId)
      .map((r) => ({
        id: Number(r.id),
        type: String(r.type) as TicketEventType,
        fromValue: r.from_value == null ? null : String(r.from_value),
        toValue: r.to_value == null ? null : String(r.to_value),
        actor: String(r.actor_user_id),
        source: String(r.source) as TicketEventSource,
        at: String(r.at),
      }));
  }
}

const stores = new WeakMap<DatabaseSync, ProjectsStore>();

/** The projects store of a database; its migrations run on first use. */
export function projectsStore(db: DatabaseSync): ProjectsStore {
  let store = stores.get(db);
  if (!store) stores.set(db, (store = new ProjectsStore(db)));
  return store;
}

function toProject(row: Record<string, SQLOutputValue>): Project {
  return {
    id: Number(row.id),
    key: String(row.key),
    name: String(row.name),
    template: String(row.template),
    visibility: row.visibility === 'private' ? 'private' : 'public',
    categoryId: String(row.category_id),
    forumId: String(row.forum_id),
    boardId: String(row.board_id),
    activityId: String(row.activity_id),
    roleId: String(row.role_id),
    boardMessageIds: JSON.parse(String(row.board_message_ids)) as Record<string, string>,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}
