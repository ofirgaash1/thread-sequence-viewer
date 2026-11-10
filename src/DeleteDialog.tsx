import { useEffect, useRef, useState } from "react";
import { GitHubAuthError, deleteArtwork, storeToken, storedToken } from "./githubDelete";

const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

type Artwork = { id: string; label: string; file: string };

export function DeleteDialog({
  artwork,
  onCancel,
  onDeleted,
}: {
  artwork: Artwork;
  onCancel: () => void;
  onDeleted: (artwork: Artwork) => void;
}) {
  const [savedToken, setSavedToken] = useState(storedToken);
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const useToken = savedToken ?? token.trim();
    if (!useToken) return;
    setBusy(true);
    setError(null);
    try {
      await deleteArtwork(useToken, artwork);
      if (!savedToken && remember) storeToken(useToken);
      onDeleted(artwork);
    } catch (e) {
      if (e instanceof GitHubAuthError && savedToken) {
        storeToken(null);
        setSavedToken(null);
      }
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="delete-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form onSubmit={submit}>
        <h2>Delete “{artwork.label}”?</h2>
        <p className="dialog-text">
          It will be removed from the site for everyone. The site updates in about a minute.
        </p>

        {savedToken ? (
          <p className="dialog-note">
            Using the GitHub token saved on this device.{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                storeToken(null);
                setSavedToken(null);
              }}
            >
              Forget it
            </button>
          </p>
        ) : (
          <>
            <label className="field">
              <span>GitHub token</span>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_…"
              />
            </label>
            <p className="dialog-note">
              A{" "}
              <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
                fine-grained token
              </a>{" "}
              with access to this repository only and Contents: Read and write.
            </p>
            <label className="switch">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
              Remember on this device
            </label>
          </>
        )}

        {error && <p className="dialog-error">{error}</p>}

        <div className="dialog-actions">
          <button type="button" className="text-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="danger-button"
            disabled={busy || (!savedToken && !token.trim())}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
