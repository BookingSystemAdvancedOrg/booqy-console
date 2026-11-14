import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Icon } from "../../components/ds";
import { Printing } from "../../components/ui";
import { confirmLeave } from "../../components/save";
import { HelpLimited, askHelp, getHelpStatus } from "./helpApi";
import type { HelpTurn } from "./helpApi";
import { resolveLive } from "./live";
import { spotlight } from "./spotlight";
import { OPEN_EVENT, helpChatEnabled, setHelpChatEnabled } from "./chatState";
import { KB, actionAllowed, actionHref } from "./kb";
import type { HelpAction, HelpAnswer } from "./kb";
import "./helpChat.css";

/**
 * Ask Booqy: a glass panel at the bottom right (full screen on phones) where
 * operators ask how the console works. Answers come step by step from the
 * corpus, with a button that takes them to the right page and lights up the
 * place. Buttons are checked here (kb.ts actionAllowed) whatever the server
 * sends. Live numbers are read with the operator's own token (live.ts); the
 * page they come from opens with the figure lit up and the panel stays.
 * The conversation lives only in this tab's memory.
 *
 * Opens from the launcher or from Cmd/Ctrl+K ("Ask the help assistant").
 */

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; answer: HelpAnswer }
  | { id: number; role: "notice"; text: string };

let nextId = 1;

export const LIMITED_TEXT = "You've asked a lot in a short time. Wait a moment and try again.";
const FAILED_TEXT = "I couldn't get an answer right now. Try again in a moment.";
const LIVE_FAILED_TEXT = "I couldn't fetch that number right now. The button below opens the page that shows it.";

export function HelpChat() {
  const navigate = useNavigate();
  const location = useLocation();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const panelId = useId();

  useEffect(() => {
    let alive = true;
    void getHelpStatus().then((s) => {
      if (!alive) return;
      setHelpChatEnabled(s.enabled);
      setEnabled(s.enabled);
    });
    return () => {
      alive = false;
      setHelpChatEnabled(false);
    };
  }, []);

  const show = useCallback(() => {
    if (!helpChatEnabled()) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    // Back where the operator was; the launcher is drawn again once the panel closes.
    requestAnimationFrame(() => {
      const back = returnTo.current?.isConnected ? returnTo.current : launcherRef.current;
      back?.focus?.();
    });
  }, []);

  useEffect(() => {
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, [show]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, waiting]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || waiting) return;
    const history: HelpTurn[] = messages.flatMap((m): HelpTurn[] =>
      m.role === "user" ? [{ role: "user", text: m.text }] : m.role === "assistant" ? [{ role: "assistant", text: m.answer.text }] : [],
    );
    setMessages((ms) => [...ms, { id: nextId++, role: "user", text }]);
    setDraft("");
    setWaiting(true);
    try {
      let answer = await askHelp(text, history);
      if (answer.live) answer = await withLive(answer);
      setMessages((ms) => [...ms, { id: nextId++, role: "assistant", answer }]);
      // A live number is also shown where it lives, lit up, with the panel still open.
      if (answer.live && answer.actions[0] && actionAllowed(answer.actions[0])) go(answer.actions[0], { keepOpen: true });
    } catch (err) {
      setMessages((ms) => [...ms, { id: nextId++, role: "notice", text: err instanceof HelpLimited ? LIMITED_TEXT : FAILED_TEXT }]);
    } finally {
      setWaiting(false);
      inputRef.current?.focus();
    }
  };

  const withLive = async (answer: HelpAnswer): Promise<HelpAnswer> => {
    let text: string | null = null;
    try {
      text = await resolveLive(answer.live!);
    } catch {
      text = null;
    }
    return { ...answer, text: text ?? LIVE_FAILED_TEXT };
  };

  /** Where the button points, and light up the targets. Already there: it only scrolls and lights up. */
  function go(action: HelpAction, opts: { keepOpen?: boolean } = {}) {
    if (!actionAllowed(action)) return;
    const samePage =
      location.pathname === action.to &&
      (!action.hash || location.hash === `#${action.hash}`) &&
      Object.entries(action.query ?? {}).every(([k, v]) => new URLSearchParams(location.search).get(k) === v);
    if (!samePage) {
      // A form with unsaved changes asks first, like every other link.
      if (!confirmLeave()) return;
      navigate(actionHref(action));
    }
    // On a phone the panel covers the page: close it so the operator sees where they landed.
    if (!opts.keepOpen && window.matchMedia?.("(max-width: 600px)").matches) close();
    if (action.highlight?.length) void spotlight(action.highlight);
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };
  const onInputKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(draft);
    }
  };

  if (!enabled) return null;

  const suggestions = KB.entries.filter((e) => e.suggestion).slice(0, 3).map((e) => e.suggestion as string);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <>
      {!open && (
        <button ref={launcherRef} type="button" className="help-launcher" aria-label="Ask Booqy" title="Ask Booqy" aria-expanded={false} aria-controls={panelId} onClick={show}>
          <Icon name="search" size={18} />
          <span className="help-launcher-text">Ask Booqy</span>
        </button>
      )}
      {open && (
        <section
          id={panelId}
          className="help-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <header className="help-head">
            <div>
              <h2 className="help-title" id={titleId}>Help assistant</h2>
              <p className="help-sub">Answers from how Booqy Console works</p>
            </div>
            <div className="help-head-actions">
              {messages.length > 0 && (
                <button type="button" className="help-icon-btn" onClick={() => setMessages([])} aria-label="Start over" title="Start over">
                  <Icon name="rotate" size={16} />
                </button>
              )}
              <button type="button" className="help-icon-btn" onClick={close} aria-label="Close the help assistant" title="Close">
                <Icon name="close" size={16} />
              </button>
            </div>
          </header>

          <ol className="help-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
            {messages.length === 0 && (
              <li className="help-empty">
                <p>Ask how something works in the console, and I'll show the steps and take you there.</p>
                {suggestions.length > 0 && (
                  <div className="help-suggestions">
                    {suggestions.map((s) => (
                      <button key={s} type="button" className="help-chip" onClick={() => void ask(s)}>{s}</button>
                    ))}
                  </div>
                )}
              </li>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <li key={m.id} className="help-msg help-msg--user">
                  <span className="sr-only">You: </span>
                  {m.text}
                </li>
              ) : m.role === "notice" ? (
                <li key={m.id} className="help-msg help-msg--notice" role="status">{m.text}</li>
              ) : (
                <li key={m.id} className="help-msg help-msg--bot">
                  <span className="sr-only">Assistant: </span>
                  <p className="help-answer">{m.answer.text}</p>
                  {m.answer.steps.length > 0 && (
                    <ol className="help-steps">
                      {m.answer.steps.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  )}
                  <Actions actions={m.answer.actions.filter((a) => actionAllowed(a))} primary={m.id === lastAssistant} onGo={go} />
                </li>
              ),
            )}
            {waiting && (
              <li className="help-msg help-msg--bot help-msg--waiting">
                <Printing inline label="Looking it up" />
              </li>
            )}
          </ol>

          <form className="help-compose" onSubmit={onSubmit}>
            <label className="sr-only" htmlFor={`${panelId}-q`}>Your question</label>
            <textarea
              id={`${panelId}-q`}
              ref={inputRef}
              className="input help-input"
              rows={1}
              maxLength={500}
              placeholder="For example: How do I change a customer's plan?"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onInputKey}
            />
            <button type="submit" className="help-send" disabled={!draft.trim() || waiting} aria-label="Send the question">
              <Icon name="send" size={18} />
            </button>
          </form>
        </section>
      )}
    </>
  );
}

function Actions({ actions, primary, onGo }: { actions: HelpAction[]; primary: boolean; onGo: (a: HelpAction) => void }) {
  if (actions.length === 0) return null;
  return (
    <div className="help-actions">
      {actions.map((a, i) => (
        <button key={a.id} type="button" className={`btn ${primary && i === 0 ? "btn--primary" : "btn--ghost"} help-go`} onClick={() => onGo(a)}>
          {a.label}
          <Icon name="arrow-right" size={16} />
        </button>
      ))}
    </div>
  );
}
