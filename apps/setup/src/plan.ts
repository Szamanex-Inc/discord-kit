import { FEATURES, killedFeatures, presetEnabled, type Preset } from '@discord-kit/config';

/** Prints what would be created on the server. Works offline, no token needed. */
export function printPlan(preset: Preset): void {
  const { config, memberRoles } = preset;
  console.log('ROLES (highest first):');
  for (const r of config.roles) {
    const extra: string[] = [];
    if (r.color) extra.push(r.color);
    if (r.hoist) extra.push('separate in member list');
    if (r.perms?.length) extra.push('permissions: ' + r.perms.join(', '));
    console.log(`  @${r.name}` + (extra.length ? `  (${extra.join('; ')})` : ''));
  }

  console.log('\nCHANNELS:');
  for (const cat of config.categories) {
    let vis = '';
    if (cat.private?.length) vis = `  [only: ${cat.private.join(', ')}]`;
    else if (cat.members_only) vis = `  [only: ${memberRoles.join(', ')}]`;
    console.log(`  ${cat.name}${vis}`);
    for (const ch of cat.channels ?? []) {
      const kind = ch.type ?? 'text';
      const flags: string[] = [];
      if (ch.read_only) flags.push(`read-only, writers: ${(ch.writers ?? []).join(', ')}`);
      if (ch.private?.length) flags.push(`only: ${ch.private.join(', ')}`);
      if (ch.members_only) flags.push('members only');
      if (ch.user_limit) flags.push(`limit ${ch.user_limit}`);
      if (ch.content) flags.push(`content from ${ch.content}`);
      if (ch.system_channel) flags.push('join messages');
      const prefix = kind === 'voice' ? '🔊 ' : '#';
      console.log(`    ${prefix}${ch.name} [${kind}]` + (flags.length ? `  (${flags.join('; ')})` : ''));
    }
  }

  console.log('\nBOT FEATURES (apps/bot, preset values; /feature overrides are stored by the bot):');
  const killed = killedFeatures();
  for (const name of FEATURES) {
    const state = presetEnabled(preset, name) ? 'enabled' : 'disabled';
    console.log(`  ${name}: ${state}` + (killed.has(name) ? ' (killed by DISABLED_FEATURES)' : ''));
  }
}
