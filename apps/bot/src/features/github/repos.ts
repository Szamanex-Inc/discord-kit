import type { StatusSpec } from '@discord-kit/config';
import type { RepoCheck } from '../projects/hooks.ts';
import type { ProjectsStore } from '../projects/store.ts';
import type { GitHubClient } from './client.ts';
import { statusLabels } from './labels.ts';

/**
 * Whether a repo can be added to a project: it belongs to no other project and the app is
 * installed on it. If so, the status labels are created in it and its open issues counted.
 */
export async function checkRepo(
  client: GitHubClient,
  store: ProjectsStore,
  /** The project the repo is added to; undefined while /project create checks repos first. */
  projectId: number | undefined,
  owner: string,
  name: string,
  template: StatusSpec[],
  prefix: string,
): Promise<RepoCheck> {
  const other = store.projectByRepo(owner, name);
  if (other && other.id !== projectId) {
    return {
      ok: false,
      reason: `\`${owner}/${name}\` already belongs to **${other.name}**; a repo can be in one project.`,
    };
  }
  if (!(await client.installationFor(owner, name))) {
    const link = `https://github.com/apps/${await client.appSlug()}/installations/new`;
    return {
      ok: false,
      reason: `The GitHub App is not installed on \`${owner}/${name}\`. Install it (choose that repo), then try again: ${link}`,
    };
  }
  await client.ensureLabels(owner, name, statusLabels(template, prefix));
  return { ok: true, openIssues: await client.countOpenIssues(owner, name) };
}
