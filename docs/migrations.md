# Preset migrations

`schema_version` in a preset's `config.yaml` must match the version the code supports. When the format changes in a breaking way, the version is bumped and the steps to migrate are listed here.

## 1 → 2

Feature settings moved under `features`, each feature got an explicit `enabled`, and the environment override changed.

1. Set `schema_version: 2`.
2. Move the top-level `role_picker:` section under `features:` and add `enabled`:

   ```yaml
   # before
   features:
     role_picker: true
   role_picker:
     channel: pick-roles
     menus: [...]

   # after
   features:
     role_picker:
       enabled: true
       channel: pick-roles
       menus: [...]
   ```

3. Optional: add `bot.admin_roles` with the roles allowed to use `/feature` (Administrator always can).
4. Environment: `FEATURE_<NAME>=false` no longer exists. Use `/feature off <name>` for a runtime change, or `DISABLED_FEATURES=<name>` as a kill switch.
5. Docker: mount a writable volume at `/data` so runtime overrides survive restarts.
