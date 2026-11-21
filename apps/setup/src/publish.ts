import { MessageFlags, type Client, type Guild, type Message } from 'discord.js';
import { channelName, readContent, type Preset } from '@discord-kit/config';
import { configuredChannels, REASON } from './discord.ts';

/** Discord allows 2000 characters per message, keep some headroom. */
const MAX_LEN = 1900;

/** Splits text into chunks that fit in one message, preferably at paragraph boundaries. */
export function splitContent(text: string, maxLen = MAX_LEN): string[] {
  const chunks: string[] = [];
  let cur = '';
  const push = (part: string) => {
    if (cur && (cur + '\n\n' + part).length > maxLen) {
      chunks.push(cur);
      cur = part;
    } else {
      cur = cur ? cur + '\n\n' + part : part;
    }
  };
  for (const para of text.trim().split(/\n{2,}/)) {
    if (para.length <= maxLen) push(para);
    else for (let i = 0; i < para.length; i += maxLen) push(para.slice(i, i + maxLen));
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Posts or updates channel content from `content` files. The bot edits its earlier
 * messages instead of sending new ones and only deletes its own surplus messages.
 */
export async function runPublish(client: Client<true>, guild: Guild, preset: Preset): Promise<void> {
  console.log(`Server: ${guild.name}\nCONTENT:`);
  const flags = MessageFlags.SuppressEmbeds;
  const allowedMentions = { parse: [] }; // publishing never pings anyone

  for (const [spec, channel] of configuredChannels(guild, preset)) {
    if (!spec.content) continue;
    if (!channel?.isTextBased()) {
      console.log(`  ! #${channelName(spec)} does not exist, run pnpm server:setup first`);
      continue;
    }
    const chunks = splitContent(readContent(preset, spec));

    // The bot's content messages (without menus), oldest first. Pinned ones too, because in
    // channels where people post, the bot's content quickly falls out of the last 100.
    const recent = [...(await channel.messages.fetch({ limit: 100 })).values()];
    const pinned = (await channel.messages.fetchPins()).items.map((p) => p.message);
    const mine: Message[] = [...new Map([...recent, ...pinned].map((m) => [m.id, m])).values()]
      .filter((m) => m.author.id === client.user.id && m.components.length === 0)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    let changed = 0;
    for (const [i, content] of chunks.entries()) {
      const existing = mine[i];
      if (existing) {
        if (existing.content !== content) {
          await existing.edit({ content, flags, allowedMentions });
          changed++;
        }
      } else {
        const msg = await channel.send({ content, flags, allowedMentions });
        if (!spec.read_only) await msg.pin(REASON).catch(() => {});
        changed++;
      }
    }
    for (const extra of mine.slice(chunks.length)) {
      await extra.delete();
      changed++;
    }
    console.log(changed ? `  ~ #${channel.name} updated` : `  = #${channel.name} unchanged`);
  }
  console.log('\nDone.');
}
