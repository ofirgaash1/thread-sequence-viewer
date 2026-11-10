// Deleting an artwork from the live site. The site is static (GitHub Pages serves docs/ from the repo), so a
// delete is a commit: the artwork's zip is removed from public/sequences and docs/sequences, and its entry from
// both manifest.json files (public/ is what the next build copies into docs/, so both must lose it). The commit
// is made straight from the browser through the GitHub API with the owner's access token, which is the
// "password": without a token that can write to this repo nothing can be deleted. Pages redeploys in ~1 minute.

const FALLBACK_REPO = "ofirgaash1/thread-sequence-viewer";
const BRANCH = "main";
const SEQUENCE_FOLDERS = ["public/sequences", "docs/sequences"];
const TOKEN_KEY = "thread-viewer:github-token";

export class GitHubAuthError extends Error {}

/** owner/repo: from <owner>.github.io/<repo>/ when served by Pages, else this project's repo. */
function repoSlug(): string {
  const host = window.location.hostname;
  const repo = window.location.pathname.split("/").filter(Boolean)[0];
  if (host.endsWith(".github.io") && repo) return `${host.split(".")[0]}/${repo}`;
  return FALLBACK_REPO;
}

export function storedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private windows may refuse storage; the token is then asked for each time.
  }
}

async function github<T>(token: string, path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repoSlug()}${path}`, {
    ...init,
    // GitHub's API responses are cacheable for 60 s; a cached ref makes a second delete build on a stale head.
    cache: "no-store",
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 401) throw new GitHubAuthError("GitHub rejected this token.");
  if (response.status === 403 || response.status === 404) {
    throw new GitHubAuthError(`This token cannot write to ${repoSlug()}.`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`GitHub error ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return (accept.includes("raw") ? response.text() : response.json()) as Promise<T>;
}

type TreeEntry = { path: string; type: string };

async function commitDeletion(token: string, entry: { id: string; label: string; file: string }): Promise<void> {
  const ref = await github<{ object: { sha: string } }>(token, `/git/ref/heads/${BRANCH}`);
  const head = ref.object.sha;
  const commit = await github<{ tree: { sha: string } }>(token, `/git/commits/${head}`);
  const tree = await github<{ tree: TreeEntry[] }>(token, `/git/trees/${commit.tree.sha}?recursive=1`);
  const paths = new Map(tree.tree.filter((item) => item.type === "blob").map((item) => [item.path.toLowerCase(), item.path]));

  const changes: { path: string; mode: "100644"; type: "blob"; sha?: null; content?: string }[] = [];
  for (const folder of SEQUENCE_FOLDERS) {
    const zipPath = paths.get(`${folder}/${entry.file}`.toLowerCase());
    if (zipPath) changes.push({ path: zipPath, mode: "100644", type: "blob", sha: null });

    const manifestPath = `${folder}/manifest.json`;
    if (!paths.has(manifestPath)) continue;
    const text = await github<string>(
      token,
      `/contents/${manifestPath}?ref=${head}`,
      {},
      "application/vnd.github.raw+json",
    );
    const manifest = JSON.parse(text) as { sequences?: { id: string }[] };
    const sequences = manifest.sequences ?? [];
    const remaining = sequences.filter((item) => item.id !== entry.id);
    if (remaining.length !== sequences.length) {
      changes.push({
        path: manifestPath,
        mode: "100644",
        type: "blob",
        content: `${JSON.stringify({ ...manifest, sequences: remaining }, null, 2)}\n`,
      });
    }
  }
  if (!changes.length) return; // already gone

  const newTree = await github<{ sha: string }>(token, "/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: commit.tree.sha, tree: changes }),
  });
  const newCommit = await github<{ sha: string }>(token, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message: `Delete ${entry.label} from the gallery`, tree: newTree.sha, parents: [head] }),
  });
  await github(token, `/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
}

/**
 * Removes the artwork from the repo in one commit on main. If main moved in between (a second delete, or the Build
 * site Action committing the rebuild of the previous one), GitHub answers 422 and the commit is redone on the new
 * head, a few times with a short pause.
 */
export async function deleteArtwork(token: string, entry: { id: string; label: string; file: string }): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await commitDeletion(token, entry);
      return;
    } catch (error) {
      if ((error as { status?: number }).status !== 422 || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}
