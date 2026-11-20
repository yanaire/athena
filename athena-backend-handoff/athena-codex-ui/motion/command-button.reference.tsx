"use client";

/**
 * Command button, DesignBookmark (designbookmark.com/motion).
 * React 19 + Tailwind v4 + motion. MIT.
 *
 * A quiet button that carries its own keyboard shortcut. Click it or press the
 * keys anywhere on the page and the pill stretches open into a search field,
 * keys lighting as they go down. Esc, a click outside, or leaving the field
 * empty folds it back. No shadows, no strokes.
 *
 *   <CommandButton shortcut="mod+k" onSearch={(q) => run(q)}>Search</CommandButton>
 *
 * How it is built:
 * - Motion values, not React state, drive the press, so a press never
 *   re-renders the component; a spring follows the value on its own.
 * - Colors are the CSS variables in THEME below. Change them there, or pass
 *   `style={{ "--cb-bg": "#fff" }}` to recolor one button.
 * - `bounce` (0-100) and `width` tune the open from outside.
 */

import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";

// ---- Look and motion: everything worth tuning lives here. -----------------

const THEME = {
  "--cb-bg": "#2c2c2c",
  "--cb-bg-hover": "#333333",
  "--cb-text": "rgba(255,255,255,.85)",
  "--cb-strong": "#fff",
  "--cb-placeholder": "rgba(255,255,255,.35)",
  "--cb-muted": "rgba(255,255,255,.5)",
  "--cb-key": "rgba(255,255,255,.07)",
  "--cb-key-on": "rgba(255,255,255,.18)",
} as CSSProperties;

// The press: settles in about 200ms with no overshoot.
const PRESS = { stiffness: 520, damping: 34, mass: 0.6 };
// The open: bounce 0 = no overshoot, 100 = clearly springy.
const openSpring = (bounce: number) => ({
  type: "spring" as const,
  stiffness: 300,
  damping: 34 - (Math.min(100, Math.max(0, bounce)) / 100) * 20,
});
const SWAP = { duration: 0.18, ease: [0.23, 1, 0.32, 1] } as const;

// ---- Shortcut parsing. ----------------------------------------------------

type Modifier = "mod" | "ctrl" | "alt" | "shift";
const MODIFIERS: Modifier[] = ["mod", "ctrl", "alt", "shift"];
const MAC: Record<Modifier, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const PC: Record<Modifier, string> = { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };

function parse(shortcut: string) {
  const parts = shortcut.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const modifiers = parts.filter((p): p is Modifier => MODIFIERS.includes(p as Modifier));
  const key = parts.find((p) => !MODIFIERS.includes(p as Modifier)) ?? "k";
  return { modifiers, key };
}

// By physical key too: Option on a Mac changes event.key (Option+K types "˚").
const isKey = (e: KeyboardEvent, key: string) =>
  e.key.toLowerCase() === key || e.code === `Key${key.toUpperCase()}` || e.code === `Digit${key}`;

const noSubscribe = () => () => {};
function readIsMac() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? navigator.platform);
}

function isDown(m: Modifier, e: KeyboardEvent, mac: boolean) {
  if (m === "mod") return mac ? e.metaKey : e.ctrlKey;
  if (m === "ctrl") return e.ctrlKey;
  if (m === "alt") return e.altKey;
  return e.shiftKey;
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

// ---- Parts. ---------------------------------------------------------------

function Key({ label, on = false }: { label: string; on?: boolean }) {
  return (
    <kbd
      data-on={on || undefined}
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-[var(--cb-key)] px-1.5 font-sans text-[11px] font-medium leading-none text-[var(--cb-muted)] transition-colors duration-150 data-[on]:bg-[var(--cb-key-on)] data-[on]:text-[var(--cb-strong)] data-[on]:duration-75"
    >
      {label}
    </kbd>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-[var(--cb-muted)]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

type Props = {
  children?: ReactNode;
  /** `+`-joined: `mod` (⌘ on Mac, Ctrl elsewhere), `ctrl`, `alt`, `shift`, one key. */
  shortcut?: string;
  placeholder?: string;
  /** Called with the text when Enter is pressed in the open field. */
  onSearch?: (query: string) => void;
  /** Width of the open field, in px. */
  width?: number;
  /** How springy the open is, 0 to 100. */
  bounce?: number;
  /** Fold back by itself after this many ms with nothing typed (demos). */
  autoClose?: number;
  className?: string;
  style?: CSSProperties;
};

export default function CommandButton({
  children = "Search",
  shortcut = "mod+k",
  placeholder = "Search tools...",
  onSearch,
  width = 300,
  bounce = 30,
  autoClose,
  className = "",
  style,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();
  // null on the server and in the first client render, so the markup matches; then the real answer.
  const mac = useSyncExternalStore(noSubscribe, readIsMac, () => null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Which keys are down: this one IS state, the caps need to re-render.
  const [held, setHeld] = useState<{ mods: Modifier[]; key: boolean }>({ mods: [], key: false });

  // The press is a motion value with a spring on it: no re-render per frame.
  const pressTarget = useMotionValue(1);
  const scale = useSpring(pressTarget, PRESS);
  const press = (down: boolean) => pressTarget.set(down && !reduce ? 0.97 : 1);

  const { modifiers, key } = parse(shortcut);
  const live = useRef({ modifiers, key, open });
  useLayoutEffect(() => {
    live.current = { modifiers, key, open };
  });
  // Only a real person's press takes the focus; a scripted one (a demo
  // playing by itself) must not pull focus.
  const takeFocus = useRef(false);

  const openWith = (trusted: boolean) => {
    takeFocus.current = trusted;
    setOpen(true);
  };
  const close = (trusted = false) => {
    if (!live.current.open) return;
    setOpen(false);
    setQuery("");
    input.current?.blur();
  };

  useEffect(() => {
    if (mac === null) return;
    const sync = (e: KeyboardEvent, down: boolean) => {
      const { modifiers, key } = live.current;
      const next = { mods: modifiers.filter((m) => isDown(m, e, mac)), key: down && isKey(e, key) };
      setHeld((cur) => (cur.key === next.key && cur.mods.join() === next.mods.join() ? cur : next));
      press(next.key || next.mods.length > 0);
    };
    const onDown = (e: KeyboardEvent) => {
      const { modifiers, key, open } = live.current;
      if (open) return;
      if (!modifiers.some((m) => m !== "shift") && typing(e.target)) return;
      sync(e, true);
      if (!e.repeat && modifiers.every((m) => isDown(m, e, mac)) && isKey(e, key)) {
        e.preventDefault();
        openWith(e.isTrusted);
      }
    };
    const onUp = (e: KeyboardEvent) => sync(e, false);
    const release = () => {
      setHeld({ mods: [], key: false });
      press(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mac]);

  // A click outside folds it back.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(e.isTrusted);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (!open || !autoClose || query) return;
    const t = setTimeout(() => close(false), autoClose);
    return () => clearTimeout(t);
  }, [open, autoClose, query]);

  const labels = mac === false ? PC : MAC;

  return (
    <motion.div
      ref={root}
      layout
      transition={{ layout: reduce ? { duration: 0 } : openSpring(bounce) }}
      style={{ ...THEME, ...style, scale, borderRadius: 20, width: open ? width : "auto" }}
      onPointerDown={(e) => {
        if (open) return;
        press(true);
      }}
      onPointerUp={() => press(false)}
      onPointerLeave={() => press(false)}
      className={`relative flex h-10 items-center overflow-hidden bg-[var(--cb-bg)] text-sm font-medium text-[var(--cb-text)] transition-colors duration-150 ${open ? "" : "hover:bg-[var(--cb-bg-hover)]"} ${className}`}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {open ? (
          <motion.div
            key="field"
            className="flex w-full items-center gap-2.5 pl-3.5 pr-2.5"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: { ...SWAP, delay: 0.06 } }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: SWAP }}
            onAnimationStart={() => takeFocus.current && input.current?.focus({ preventScroll: true })}
          >
            <SearchIcon />
            <input
              ref={input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") close(true);
                if (e.key === "Enter" && query.trim()) onSearch?.(query.trim());
              }}
              onBlur={() => !query && close(false)}
              placeholder={placeholder}
              aria-label={placeholder}
              className="min-w-0 flex-1 bg-transparent text-[var(--cb-strong)] outline-none placeholder:text-[var(--cb-placeholder)]"
            />
            <Key label="Esc" />
          </motion.div>
        ) : (
          <motion.button
            key="button"
            type="button"
            aria-keyshortcuts={[...modifiers.map((m) => (m === "mod" ? (mac ? "Meta" : "Control") : m[0].toUpperCase() + m.slice(1))), key.toUpperCase()].join("+")}
            aria-expanded={false}
            onClick={(e) => openWith(e.isTrusted)}
            className="flex h-10 cursor-pointer select-none items-center gap-3 whitespace-nowrap pl-4 pr-2.5 outline-none"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: { ...SWAP, delay: 0.06 } }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: SWAP }}
          >
            {children}
            <span aria-hidden="true" className={`flex items-center gap-1 transition-opacity duration-200 ${mac === null ? "opacity-0" : ""}`}>
              {modifiers.map((m) => (
                <Key key={m} label={labels[m]} on={held.mods.includes(m)} />
              ))}
              <Key label={key.length === 1 ? key.toUpperCase() : key} on={held.key} />
            </span>
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
