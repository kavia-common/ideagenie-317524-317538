import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  exportIdea,
  generateIdeas,
  listSavedIdeas,
  saveIdea,
  shareIdea,
} from "./services/api";
import { copyToClipboard, downloadTextFile } from "./utils/clientActions";

/**
 * Create a stable client-side id for locally generated ideas that aren't saved yet.
 */
function makeLocalId() {
  return `local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// PUBLIC_INTERFACE
function App() {
  /** Main application entry point for IdeaGenie (AI idea generator). */
  const [theme, setTheme] = useState("light");

  // Input controls
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState("Creative");
  const [count, setCount] = useState(6);

  // Generated ideas state
  const [ideas, setIdeas] = useState([]); // {id, text, savedId?, savedAt?}
  const [generationStatus, setGenerationStatus] = useState("idle"); // idle|loading|error|success
  const [generationError, setGenerationError] = useState("");

  // Saved ideas sidebar/panel
  const [savedIdeas, setSavedIdeas] = useState([]);
  const [savedStatus, setSavedStatus] = useState("idle"); // idle|loading|error|success
  const [savedError, setSavedError] = useState("");

  // Per-idea action loading/error
  const [busyByIdeaId, setBusyByIdeaId] = useState({}); // { [id]: { saving?:bool, sharing?:bool, exporting?:bool } }
  const [errorByIdeaId, setErrorByIdeaId] = useState({}); // { [id]: string }

  // Toast-like inline status
  const [notice, setNotice] = useState(null); // { type: 'success'|'error'|'info', message: string }
  const noticeTimerRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    // initial load of saved ideas (non-blocking to main UI)
    let cancelled = false;
    (async () => {
      setSavedStatus("loading");
      setSavedError("");
      try {
        const data = await listSavedIdeas();
        if (cancelled) return;

        // Accept either {items:[...]} or [...], depending on backend implementation.
        const items = Array.isArray(data) ? data : data?.items || [];
        setSavedIdeas(items);
        setSavedStatus("success");
      } catch (e) {
        if (cancelled) return;
        setSavedStatus("error");
        setSavedError(e?.message || "Failed to load saved ideas.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const canGenerate = useMemo(() => topic.trim().length >= 3 && generationStatus !== "loading", [topic, generationStatus]);

  // PUBLIC_INTERFACE
  const toggleTheme = () => {
    /** Toggle light/dark theme. */
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  function setIdeaBusy(id, patch) {
    setBusyByIdeaId((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), ...patch },
    }));
  }

  function setIdeaError(id, message) {
    setErrorByIdeaId((prev) => ({ ...prev, [id]: message || "" }));
  }

  function showNotice(type, message) {
    setNotice({ type, message });
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3500);
  }

  async function onGenerate(e) {
    e.preventDefault();
    const trimmed = topic.trim();
    if (trimmed.length < 3) {
      setGenerationStatus("error");
      setGenerationError("Please enter at least 3 characters.");
      return;
    }

    setGenerationStatus("loading");
    setGenerationError("");
    setIdeas([]);

    try {
      const result = await generateIdeas({ topic: trimmed, tone, count });

      // Accept flexible shapes:
      // - { ideas: string[] }
      // - { items: [{text:...}] }
      // - string[] directly
      const list =
        (Array.isArray(result) && result) ||
        result?.ideas ||
        result?.items ||
        [];

      const normalized = list
        .map((item) => (typeof item === "string" ? item : item?.text || item?.idea || ""))
        .filter(Boolean)
        .slice(0, Math.max(1, Number(count) || 6))
        .map((text) => ({ id: makeLocalId(), text }));

      setIdeas(normalized);
      setGenerationStatus("success");
      showNotice("success", "Ideas generated.");
    } catch (e2) {
      setGenerationStatus("error");
      setGenerationError(e2?.message || "Failed to generate ideas.");
    }
  }

  async function onSave(idea) {
    setIdeaError(idea.id, "");
    setIdeaBusy(idea.id, { saving: true });
    try {
      const data = await saveIdea({ topic: topic.trim(), idea: idea.text });

      // Accept {id, ...} or {idea:{id}} or similar
      const savedId = data?.id || data?.idea?.id || data?.idea_id || data?.ideaId;

      showNotice("success", "Saved.");
      setIdeas((prev) =>
        prev.map((it) =>
          it.id === idea.id
            ? { ...it, savedId: savedId || it.savedId || it.id, savedAt: new Date().toISOString() }
            : it
        )
      );

      // refresh saved list (best-effort)
      try {
        const refreshed = await listSavedIdeas();
        const items = Array.isArray(refreshed) ? refreshed : refreshed?.items || [];
        setSavedIdeas(items);
        setSavedStatus("success");
      } catch {
        // ignore
      }
    } catch (e) {
      setIdeaError(idea.id, e?.message || "Failed to save.");
      showNotice("error", "Save failed.");
    } finally {
      setIdeaBusy(idea.id, { saving: false });
    }
  }

  async function onShare(idea) {
    const id = idea.savedId;
    if (!id) {
      setIdeaError(idea.id, "Save the idea before sharing.");
      return;
    }
    setIdeaError(idea.id, "");
    setIdeaBusy(idea.id, { sharing: true });

    try {
      const data = await shareIdea({ ideaId: id });

      // Accept {url} or {share_url} etc.
      const url = data?.url || data?.share_url || data?.shareUrl || data?.link || "";
      if (!url) {
        throw new Error("Backend did not return a share URL.");
      }
      await copyToClipboard(url);
      showNotice("success", "Share link copied to clipboard.");
    } catch (e) {
      setIdeaError(idea.id, e?.message || "Failed to share.");
      showNotice("error", "Share failed.");
    } finally {
      setIdeaBusy(idea.id, { sharing: false });
    }
  }

  async function onExport(idea, format) {
    const id = idea.savedId;
    if (!id) {
      // Allow exporting unsaved idea client-side as a fallback
      const safeName = (topic.trim() || "idea").slice(0, 40).replace(/[^\w\- ]+/g, "").trim() || "idea";
      const base = `${safeName}-${idea.id.slice(-6)}`;
      if (format === "txt") {
        downloadTextFile({ filename: `${base}.txt`, content: idea.text, mimeType: "text/plain;charset=utf-8" });
        showNotice("success", "Exported as .txt");
        return;
      }
      if (format === "json") {
        downloadTextFile({
          filename: `${base}.json`,
          content: JSON.stringify({ topic: topic.trim(), idea: idea.text }, null, 2),
          mimeType: "application/json;charset=utf-8",
        });
        showNotice("success", "Exported as .json");
        return;
      }
      setIdeaError(idea.id, "Save the idea before exporting in this format.");
      return;
    }

    setIdeaError(idea.id, "");
    setIdeaBusy(idea.id, { exporting: true });

    try {
      const data = await exportIdea({ ideaId: id, format });

      // Accept either:
      // - { filename, content, mimeType }
      // - string body (already content)
      // - { content }
      const content =
        (typeof data === "string" ? data : null) ||
        data?.content ||
        data?.data ||
        JSON.stringify(data, null, 2);

      const filename =
        data?.filename ||
        `idea-${id}.${format === "md" ? "md" : format === "txt" ? "txt" : "json"}`;

      const mimeType =
        data?.mimeType ||
        (format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8");

      downloadTextFile({ filename, content, mimeType });
      showNotice("success", `Exported ${format.toUpperCase()}.`);
    } catch (e) {
      setIdeaError(idea.id, e?.message || "Failed to export.");
      showNotice("error", "Export failed.");
    } finally {
      setIdeaBusy(idea.id, { exporting: false });
    }
  }

  const headerSubtitle = "Generate creative ideas, suggestions, and solutions from any topic—then save, share, or export them.";

  return (
    <div className="App">
      <header className="appShell">
        <div className="topBar">
          <div className="brand">
            <div className="brandMark" aria-hidden="true">IG</div>
            <div className="brandText">
              <div className="brandTitle">IdeaGenie</div>
              <div className="brandSubtitle">AI Idea Generator</div>
            </div>
          </div>

          <button
            className="btn btn-secondary"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            type="button"
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
        </div>

        <main className="container">
          <section className="hero">
            <h1 className="title">Turn prompts into possibilities</h1>
            <p className="subtitle">{headerSubtitle}</p>
          </section>

          {notice && (
            <div className={`notice notice-${notice.type}`} role="status" aria-live="polite">
              {notice.message}
            </div>
          )}

          <section className="card">
            <form onSubmit={onGenerate} className="generatorForm">
              <div className="field">
                <label className="label" htmlFor="topic">
                  Topic or question
                </label>
                <textarea
                  id="topic"
                  className="textarea"
                  rows={3}
                  placeholder="e.g., How can a small coffee shop increase weekday foot traffic?"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
                <div className="helpRow">
                  <span className="helpText">Be specific for better ideas.</span>
                  <span className="helpText">{Math.min(500, topic.length)}/500</span>
                </div>
              </div>

              <div className="controlsRow">
                <div className="field field-inline">
                  <label className="label" htmlFor="tone">Tone</label>
                  <select
                    id="tone"
                    className="select"
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                  >
                    <option>Creative</option>
                    <option>Practical</option>
                    <option>Technical</option>
                    <option>Marketing</option>
                    <option>Friendly</option>
                    <option>Professional</option>
                  </select>
                </div>

                <div className="field field-inline">
                  <label className="label" htmlFor="count">Ideas</label>
                  <select
                    id="count"
                    className="select"
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  >
                    <option value={3}>3</option>
                    <option value={6}>6</option>
                    <option value={9}>9</option>
                    <option value={12}>12</option>
                  </select>
                </div>

                <div className="field field-inline field-grow">
                  <button className="btn btn-primary btn-large" type="submit" disabled={!canGenerate}>
                    {generationStatus === "loading" ? "Generating…" : "Generate ideas"}
                  </button>
                </div>
              </div>

              {generationStatus === "error" && (
                <div className="inlineError" role="alert">
                  {generationError || "Something went wrong."}
                </div>
              )}
            </form>
          </section>

          <section className="grid">
            <div className="panel">
              <div className="panelHeader">
                <h2 className="panelTitle">Generated ideas</h2>
                <div className="panelMeta">
                  {generationStatus === "loading" ? "Working…" : ideas.length ? `${ideas.length} ideas` : "No ideas yet"}
                </div>
              </div>

              <div className="panelBody">
                {generationStatus === "loading" && (
                  <div className="skeletonList" aria-label="Loading ideas">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div className="skeletonCard" key={i}>
                        <div className="skeletonLine w80" />
                        <div className="skeletonLine w60" />
                        <div className="skeletonLine w40" />
                      </div>
                    ))}
                  </div>
                )}

                {generationStatus !== "loading" && ideas.length === 0 && (
                  <div className="emptyState">
                    <div className="emptyTitle">Start by generating ideas</div>
                    <div className="emptyText">Enter a topic/question above, then hit “Generate ideas”.</div>
                  </div>
                )}

                {generationStatus !== "loading" && ideas.length > 0 && (
                  <ul className="ideaList">
                    {ideas.map((idea) => {
                      const busy = busyByIdeaId[idea.id] || {};
                      const perIdeaErr = errorByIdeaId[idea.id] || "";
                      const isSaved = Boolean(idea.savedId);

                      return (
                        <li key={idea.id} className="ideaCard">
                          <div className="ideaText">{idea.text}</div>

                          <div className="ideaActions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              onClick={() => copyToClipboard(idea.text).then(() => showNotice("success", "Copied."))}
                            >
                              Copy
                            </button>

                            <button
                              type="button"
                              className="btn btn-primary btn-small"
                              onClick={() => onSave(idea)}
                              disabled={busy.saving}
                              aria-busy={busy.saving ? "true" : "false"}
                            >
                              {busy.saving ? "Saving…" : isSaved ? "Saved" : "Save"}
                            </button>

                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              onClick={() => onShare(idea)}
                              disabled={busy.sharing}
                              aria-busy={busy.sharing ? "true" : "false"}
                              title={isSaved ? "Copy share link" : "Save first to share via backend"}
                            >
                              {busy.sharing ? "Sharing…" : "Share"}
                            </button>

                            <div className="exportGroup">
                              <button
                                type="button"
                                className="btn btn-secondary btn-small"
                                onClick={() => onExport(idea, "txt")}
                                disabled={busy.exporting}
                              >
                                {busy.exporting ? "Exporting…" : "Export TXT"}
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-small"
                                onClick={() => onExport(idea, "json")}
                                disabled={busy.exporting}
                              >
                                Export JSON
                              </button>
                            </div>
                          </div>

                          {perIdeaErr && (
                            <div className="inlineError" role="alert">
                              {perIdeaErr}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <aside className="panel panelSide">
              <div className="panelHeader">
                <h2 className="panelTitle">Saved</h2>
                <div className="panelMeta">
                  {savedStatus === "loading"
                    ? "Loading…"
                    : savedStatus === "error"
                      ? "Unavailable"
                      : `${savedIdeas.length}`}
                </div>
              </div>

              <div className="panelBody">
                {savedStatus === "error" && (
                  <div className="inlineError" role="alert">
                    {savedError || "Failed to load saved ideas."}
                  </div>
                )}

                {savedStatus !== "error" && savedIdeas.length === 0 && (
                  <div className="emptyState">
                    <div className="emptyTitle">No saved ideas</div>
                    <div className="emptyText">Save an idea to see it here.</div>
                  </div>
                )}

                {savedIdeas.length > 0 && (
                  <ul className="savedList">
                    {savedIdeas.slice(0, 20).map((it, idx) => {
                      const text = it?.text || it?.idea || it?.content || "";
                      const id = it?.id || it?.idea_id || it?.ideaId || String(idx);
                      return (
                        <li key={id} className="savedItem">
                          <div className="savedText">{text || "(empty)"}</div>
                          <div className="savedActions">
                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              onClick={() => copyToClipboard(text).then(() => showNotice("success", "Copied."))}
                            >
                              Copy
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </aside>
          </section>

          <footer className="footer">
            <span className="footerText">
              Tip: Save an idea to enable backend-based sharing/export (links, filenames, formats).
            </span>
          </footer>
        </main>
      </header>
    </div>
  );
}

export default App;
