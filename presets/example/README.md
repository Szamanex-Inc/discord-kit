# Example preset

A neutral example and starting point for your own preset. Every field is explained in the comments of `config.yaml`; channel content lives in `content/`.

Keep real server presets outside this repository (for example in their own private repository) and point `PRESET_DIR` at them.

## Customizing

| To change                                        | Where                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| role names                                       | `roles`, then the same names in `member_role`, `private`, `writers` and `features.role_picker.menus` |
| role permissions                                 | `perms` on the role (names like `manage_messages`)                                                   |
| categories and channels                          | `categories`                                                                                         |
| who can see / post in a channel                  | `private`, `members_only`, `read_only` + `writers` on the channel or category                        |
| join message channel                             | `system_channel: true` on the chosen channel                                                         |
| channel content                                  | files in `content/`, then `pnpm server:publish`                                                      |
| a content file name, or add a new one            | the `content` field on the channel                                                                   |
| role picker (channel, heading, options, replies) | `features.role_picker`                                                                               |
| enabled bot features                             | `features.<name>.enabled`, at runtime `/feature on                                                   | off`, kill switch `DISABLED_FEATURES` |

The preset is validated on startup: unknown keys (usually typos), wrong types and roles that are used but not defined are reported with their location, so run `pnpm server:plan` after every change.

### Renaming on a live server

Roles and channels are matched by name and nothing is ever deleted. If you only rename in the config, `server:setup` creates a new role or channel next to the old one. To rename existing ones:

1. Rename it on Discord (Server Settings → Roles, or edit the channel).
2. Rename it the same way in `config.yaml`.
3. Run `pnpm server:plan`, then `pnpm server:setup` shows `(already exists)` for that name.
