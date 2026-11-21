/**
 * Zod schema of a preset's config.yaml. Types are inferred from it, so the schema is the single
 * source of truth. Objects are strict: an unknown key (usually a typo) is an error.
 */

import { z } from 'zod';

/** The config.yaml format version this code understands. Bump it on breaking format changes. */
export const SCHEMA_VERSION = 2;

const name = z.string().trim().min(1);
const roleList = z.array(name);

export const RoleSchema = z.strictObject({
  name,
  /** Hex, e.g. "#C79C6E". */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'expected a hex color like "#C79C6E"')
    .optional(),
  /** Show as a separate group in the member list. */
  hoist: z.boolean().optional(),
  /** Allow pinging the @role. */
  mentionable: z.boolean().optional(),
  /** Permissions in snake_case, e.g. manage_messages. */
  perms: z.array(z.string().regex(/^[a-z_]+$/, 'expected snake_case, e.g. manage_messages')).optional(),
});

const access = {
  /** Visible only to these roles (and admins). */
  private: roleList.optional(),
  /** Visible only to the roles in `member_role`. */
  members_only: z.boolean().optional(),
  /** @everyone can read, only the roles in `writers` can post. */
  read_only: z.boolean().optional(),
  writers: roleList.optional(),
};

export const ChannelSchema = z.strictObject({
  name,
  type: z.enum(['text', 'voice', 'forum', 'announcement']).optional(),
  topic: z.string().max(1024).optional(),
  user_limit: z.number().int().min(0).max(99).optional(),
  /** Content file (relative to the preset) posted by `publish`. */
  content: z.string().optional(),
  /** Discord posts join messages for new members here. */
  system_channel: z.boolean().optional(),
  ...access,
});

export const CategorySchema = z.strictObject({
  name,
  channels: z.array(ChannelSchema).optional(),
  ...access,
});

export const RolePickerSchema = z.strictObject({
  channel: name,
  /** Bold heading of the menu message. */
  title: z.string().optional(),
  /** Text below the heading. */
  message: z.string().optional(),
  /** Reply after a selection. `{roles}` is replaced with the selected roles. */
  saved_reply: z.string().optional(),
  /** Reply when every role from the menu was deselected. */
  cleared_reply: z.string().optional(),
  /** Reply when handling the selection failed. */
  error_reply: z.string().optional(),
  /** At most 5 menus (Discord's limit of rows per message), each with at most 25 roles. */
  menus: z
    .array(z.strictObject({ placeholder: z.string().max(150), roles: roleList.min(1).max(25) }))
    .min(1)
    .max(5),
});

export const WelcomeSchema = z
  .strictObject({
    /** Channel for the welcome message. */
    channel: name.optional(),
    /** Message posted in `channel`. Placeholders: {user} (mention), {name}, {server}, {member_count}. */
    message: z.string().max(2000).optional(),
    /** Direct message to the new member, same placeholders. Members with closed DMs are skipped. */
    dm: z.string().max(2000).optional(),
    /** Roles given to every new member, e.g. a guest role. */
    auto_roles: roleList.optional(),
  })
  .refine((w) => w.message || w.dm || w.auto_roles?.length, {
    message: 'set at least one of message, dm or auto_roles',
  })
  .refine((w) => !w.message || w.channel, { message: 'message needs a channel', path: ['channel'] });

export const ApplicationsSchema = z.strictObject({
  /** Channel with the "apply" button. */
  channel: name,
  /** Staff channel where submitted applications are posted with accept/reject buttons. */
  review_channel: name,
  /** Bold heading of the message with the button. */
  title: z.string().optional(),
  /** Text below the heading. */
  message: z.string().optional(),
  button_label: z.string().max(80).optional(),
  /** Title of the form. */
  form_title: z.string().max(45).optional(),
  /** Form fields, at most 5 (Discord's limit for a form). */
  questions: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(45),
        placeholder: z.string().max(100).optional(),
        /** short = one line, paragraph = multi-line. */
        style: z.enum(['short', 'paragraph']).optional(),
        required: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(5),
  /** Who can accept or reject. Defaults to bot.admin_roles; Administrator always can. */
  reviewer_roles: roleList.optional(),
  /** Roles given on acceptance. */
  accept_roles: roleList.optional(),
  /** Roles removed on acceptance, e.g. a guest role. */
  remove_roles: roleList.optional(),
  /** Replies and DMs. Placeholders: {name}, {server}. */
  submitted_reply: z.string().optional(),
  pending_reply: z.string().optional(),
  accepted_dm: z.string().optional(),
  rejected_dm: z.string().optional(),
  error_reply: z.string().optional(),
  /** Texts the reviewers see. Placeholders: {id} (application number), {reviewer}. */
  staff_texts: z
    .strictObject({
      review_title: z.string().max(256).optional(),
      accept_label: z.string().max(80).optional(),
      reject_label: z.string().max(80).optional(),
      accepted: z.string().optional(),
      rejected: z.string().optional(),
      not_reviewer: z.string().optional(),
      not_found: z.string().optional(),
      already_reviewed: z.string().optional(),
      roles_failed: z.string().optional(),
      dm_closed: z.string().optional(),
      member_left: z.string().optional(),
    })
    .optional(),
});

export const EventsSchema = z.strictObject({
  /** Channel where events are announced and reminders are posted. */
  channel: name,
  /** IANA time zone used to read the time given to /event create, e.g. Europe/Warsaw. */
  timezone: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'unknown time zone')
    .optional(),
  /** Minutes before the start when a reminder is posted, e.g. [60, 15]. */
  remind_before: z.array(z.number().int().min(1).max(10080)).max(5).optional(),
  /** Roles /event create can ping (offered as choices). */
  ping_roles: roleList.max(25).optional(),
  /** Who can create and cancel events. Omitted = everyone. Administrator always can. */
  organizer_roles: roleList.optional(),
  /** Default event length in minutes (Discord needs an end time). */
  default_duration: z.number().int().min(5).max(1440).optional(),
  /** Texts. Placeholders: {title}, {time} (Discord timestamp), {relative}, {link}, {ping}, {organizer}. */
  announce: z.string().optional(),
  reminder: z.string().optional(),
  cancelled: z.string().optional(),
});

/** One status of a project template. Each status becomes a tag on the project's ticket forum. */
export const StatusSchema = z.strictObject({
  /** Stable id stored with tickets, e.g. in_progress. Rename the label freely, never the key. */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'expected snake_case starting with a letter, e.g. in_progress'),
  /** Name of the forum tag. Discord allows at most 20 characters. */
  label: name.max(20),
  /** Emoji shown on the tag and the board, e.g. 🟨. */
  emoji: z.string().optional(),
  /** A finished status: the ticket's post is archived and the board shows only a count. */
  done: z.boolean().optional(),
  /** The status the Blocked button moves to; Unblock returns to the previous status. */
  blocked: z.boolean().optional(),
});

/** Statuses of a project in board order. New tickets start in the first one. A forum has at most 20 tags. */
export const TemplateSchema = z
  .array(StatusSchema)
  .min(1)
  .max(20, 'a template can have at most 20 statuses (Discord allows 20 forum tags)')
  .superRefine((statuses, ctx) => {
    const keys = new Set<string>();
    const labels = new Set<string>();
    statuses.forEach((s, i) => {
      if (keys.has(s.key))
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `duplicate key '${s.key}'` });
      keys.add(s.key);
      const label = s.label.toLowerCase();
      if (labels.has(label)) {
        ctx.addIssue({ code: 'custom', path: [i, 'label'], message: `duplicate label '${label}'` });
      }
      labels.add(label);
      if (s.done && s.blocked) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: `status '${s.key}' cannot be both done and blocked`,
        });
      }
    });
    if (statuses.filter((s) => s.blocked).length > 1) {
      ctx.addIssue({ code: 'custom', message: 'a template can have only one blocked status' });
    }
    const first = statuses[0];
    if (first && (first.done || first.blocked)) {
      ctx.addIssue({
        code: 'custom',
        path: [0],
        message: 'the first status is where new tickets start, it cannot be done or blocked',
      });
    }
  });

export type StatusSpec = z.infer<typeof StatusSchema>;
export type TemplateSpec = z.infer<typeof TemplateSchema>;

/** Templates used when `features.projects.templates` is not set. */
export const DEFAULT_TEMPLATES: Record<string, StatusSpec[]> = {
  dev: [
    { key: 'todo', label: 'Todo', emoji: '🟦' },
    { key: 'in_progress', label: 'In progress', emoji: '🟨' },
    { key: 'testing', label: 'Testing', emoji: '🟪' },
    { key: 'blocked', label: 'Blocked', emoji: '🟥', blocked: true },
    { key: 'ready', label: 'Ready for main', emoji: '🟩' },
    { key: 'deployed', label: 'Deployed', emoji: '🚀', done: true },
  ],
  simple: [
    { key: 'todo', label: 'Todo', emoji: '🟦' },
    { key: 'doing', label: 'Doing', emoji: '🟨' },
    { key: 'done', label: 'Done', emoji: '✅', done: true },
  ],
};

/** Defaults for the optional `features.projects` settings. */
export const PROJECT_DEFAULTS = {
  role_format: 'Project: {name}',
  default_template: 'dev',
  default_visibility: 'private',
} as const;

/** The templates projects can use: `templates` from the preset if set (replacing the defaults), else the defaults. */
export function effectiveTemplates(cfg: { templates?: Record<string, StatusSpec[]> } | undefined) {
  return cfg?.templates ?? DEFAULT_TEMPLATES;
}

const ProjectsBaseSchema = z.strictObject({
  /** Who can run /project create (Administrator and bot.admin_roles always can). */
  creator_roles: roleList.optional(),
  /** Name of each project's role. {name} is the project name. Default 'Project: {name}'. */
  role_format: z.string().includes('{name}', { error: 'role_format must contain {name}' }).optional(),
  /** Template a new project uses when /project create does not name one. Default 'dev'. */
  default_template: name.optional(),
  /** Visibility of new projects: private (project members only) or public. Default private. */
  default_visibility: z.enum(['private', 'public']).optional(),
  /** Status templates by name. Setting this replaces the built-in dev and simple templates. */
  templates: z
    .record(z.string().regex(/^[a-z][a-z0-9_-]*$/, 'expected a lowercase name'), TemplateSchema)
    .optional(),
});

/** default_template must name one of the effective templates. */
function checkDefaultTemplate(
  cfg: { default_template?: string; templates?: Record<string, StatusSpec[]> },
  ctx: z.RefinementCtx,
): void {
  const name = cfg.default_template ?? PROJECT_DEFAULTS.default_template;
  const templates = effectiveTemplates(cfg);
  if (!(name in templates)) {
    ctx.addIssue({
      code: 'custom',
      path: ['default_template'],
      message:
        `template '${name}' is not defined (templates: ${Object.keys(templates).join(', ')}). ` +
        'Set default_template to one of them.',
    });
  }
}

export const ProjectsSchema = ProjectsBaseSchema.superRefine(checkDefaultTemplate);

export type ProjectsSpec = z.infer<typeof ProjectsSchema>;

/** Defaults for the optional `features.github` settings. */
export const GITHUB_DEFAULTS = {
  poll_minutes: 5,
  label_prefix: 'status: ',
  issues_for_posts: true,
} as const;

export const GithubSchema = z.strictObject({
  /** Create issues in the default repo for tickets made by posting in Discord. Default true. */
  issues_for_posts: z.boolean().optional(),
  /** How often GitHub is checked for changes, in minutes (1–60). Default 5. */
  poll_minutes: z.number().int().min(1).max(60).optional(),
  /** Prefix of the status labels the bot keeps on issues, e.g. "status: " → "status: In progress". */
  label_prefix: z.string().min(1).max(20).optional(),
});

export type GithubSpec = z.infer<typeof GithubSchema>;

/** Added to every `features.<name>` entry next to the module's own settings. */
const enabled = {
  /** Whether the module runs. Can be overridden at runtime with /feature or DISABLED_FEATURES. */
  enabled: z.boolean(),
};

/**
 * Every bot feature with its settings. A new module in apps/bot adds an entry here
 * (`z.strictObject(enabled)` when it has no settings).
 */
export const FeaturesSchema = z.strictObject({
  role_picker: RolePickerSchema.extend(enabled).optional(),
  welcome: WelcomeSchema.extend(enabled).optional(),
  applications: ApplicationsSchema.extend(enabled).optional(),
  events: EventsSchema.extend(enabled).optional(),
  // Zod does not allow extending a refined object, so the refinement is applied after extend.
  projects: ProjectsBaseSchema.extend(enabled).superRefine(checkDefaultTemplate).optional(),
  github: GithubSchema.extend(enabled).optional(),
});

export type FeaturesConfig = z.infer<typeof FeaturesSchema>;
export type FeatureName = keyof FeaturesConfig;
/** Settings of one feature as written in the preset (including `enabled`). */
export type FeatureConfig<N extends FeatureName> = NonNullable<FeaturesConfig[N]>;

/** Known bot features. */
export const FEATURES = Object.keys(FeaturesSchema.shape) as FeatureName[];

export const BotSchema = z.strictObject({
  /** Roles allowed to use admin commands such as /feature (Administrator always can). */
  admin_roles: roleList.optional(),
  /** Channel where the bot posts module errors and warnings, e.g. bot-logs. */
  log_channel: name.optional(),
});

export const ConfigSchema = z.strictObject({
  /** Must equal SCHEMA_VERSION, so an old preset fails loudly instead of being misread. */
  schema_version: z.literal(SCHEMA_VERSION, {
    error: (issue) =>
      issue.input === undefined
        ? `add "schema_version: ${SCHEMA_VERSION}" at the top of config.yaml`
        : `this version of discord-kit supports schema_version ${SCHEMA_VERSION}, the preset has ${JSON.stringify(issue.input)}. ` +
          'See docs/migrations.md in discord-kit.',
  }),
  /** Bot settings that are not tied to one feature. */
  bot: BotSchema.optional(),
  /** Bot features: `enabled` and settings per module. */
  features: FeaturesSchema.optional(),
  roles: z.array(RoleSchema).min(1),
  member_role: z.union([name, roleList]).optional(),
  categories: z.array(CategorySchema),
});

export type RoleSpec = z.infer<typeof RoleSchema>;
export type ChannelSpec = z.infer<typeof ChannelSchema>;
export type CategorySpec = z.infer<typeof CategorySchema>;
export type AccessSpec = Pick<ChannelSpec, keyof typeof access>;
export type RolePickerSpec = z.infer<typeof RolePickerSchema>;
export type WelcomeSpec = z.infer<typeof WelcomeSchema>;
export type ApplicationsSpec = z.infer<typeof ApplicationsSchema>;
export type EventsSpec = z.infer<typeof EventsSchema>;
export type RolePickerMenu = RolePickerSpec['menus'][number];
export type ChannelType = NonNullable<ChannelSpec['type']>;
export type Config = z.infer<typeof ConfigSchema>;
