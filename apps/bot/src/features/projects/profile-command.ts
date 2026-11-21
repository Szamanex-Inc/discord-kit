import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { FeatureCommand, FeatureContext } from '../../feature.ts';
import { githubHooks } from './hooks.ts';
import { isValidEmail, isValidGithubLogin, profilesStore, type Profile } from './profiles.ts';

const MODAL_ID = 'profile:edit';
const PRIVATE_NOTE = 'Only you can see this. Your email is never posted anywhere.';

function describe(profile: Profile | undefined): string {
  return [
    `GitHub: ${profile?.githubLogin ? `**${profile.githubLogin}**` : 'not set'}`,
    `Email: ${profile?.email ?? 'not set'}`,
  ].join('\n');
}

export function profileCommand(): FeatureCommand {
  return {
    data: new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Your GitHub username and email')
      .addSubcommand((s) => s.setName('edit').setDescription('Set your GitHub username and email'))
      .addSubcommand((s) => s.setName('show').setDescription('Show what is saved (only to you)'))
      .addSubcommand((s) => s.setName('clear').setDescription('Remove your saved profile'))
      .toJSON(),
    async execute(interaction, ctx) {
      const store = profilesStore(ctx.db);
      const sub = interaction.options.getSubcommand();
      if (sub === 'edit') {
        const saved = store.profile(interaction.user.id);
        const github = new TextInputBuilder()
          .setCustomId('github')
          .setLabel('GitHub username')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(39)
          .setPlaceholder('octocat');
        const email = new TextInputBuilder()
          .setCustomId('email')
          .setLabel('Email (private, never posted)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(254)
          .setPlaceholder('you@example.com');
        if (saved?.githubLogin) github.setValue(saved.githubLogin);
        if (saved?.email) email.setValue(saved.email);
        // The form must be the first response, so no defer here.
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(MODAL_ID)
            .setTitle('Your profile')
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(github),
              new ActionRowBuilder<TextInputBuilder>().addComponents(email),
            ),
        );
        return;
      }
      const content =
        sub === 'show'
          ? `${describe(store.profile(interaction.user.id))}\n-# ${PRIVATE_NOTE}`
          : store.clearProfile(interaction.user.id)
            ? 'Your profile was removed.'
            : 'You had no saved profile.';
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    },
  };
}

/** Saves the profile form. Returns false when the interaction is not that form. */
export async function handleProfileModal(
  interaction: ModalSubmitInteraction<'cached'>,
  ctx: FeatureContext,
): Promise<boolean> {
  if (interaction.customId !== MODAL_ID) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const login = interaction.fields.getTextInputValue('github').trim().replace(/^@/, '');
  const email = interaction.fields.getTextInputValue('email').trim();
  const problems: string[] = [];
  if (login && !isValidGithubLogin(login)) problems.push(`\`${login}\` is not a valid GitHub username.`);
  if (email && !isValidEmail(email)) problems.push('That email address does not look right.');
  if (login && !problems.length && (await githubHooks.loginExists(login)) === false) {
    problems.push(`There is no GitHub user \`${login}\`.`);
  }
  if (problems.length) {
    await interaction.editReply(`Not saved: ${problems.join(' ')} Run \`/profile edit\` again.`);
    return true;
  }
  const store = profilesStore(ctx.db);
  try {
    store.setProfile(interaction.user.id, { githubLogin: login || null, email: email || null });
  } catch (e) {
    await interaction.editReply(`Not saved: ${(e as Error).message}`);
    return true;
  }
  await interaction.editReply(`Saved.\n${describe(store.profile(interaction.user.id))}\n-# ${PRIVATE_NOTE}`);
  return true;
}
