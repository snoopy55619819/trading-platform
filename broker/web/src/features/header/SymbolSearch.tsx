// Pick a symbol by typing its ticker or part of its name. A combobox: arrow keys move
// through the matches, Enter picks, Escape closes. A view: it is given the symbols and
// reports the choice; it fetches nothing.
//
// Typing a letter anywhere on the page, outside another field or a dialog, starts a search
// here: no need to click the box first.

import { type KeyboardEvent, type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";

import type { Security } from "../../api/backend.ts";
import { matchSymbols, startsSearch } from "./search.ts";

/** Focuses the input when a letter is typed elsewhere on the page. */
function useTypeAnywhere(input: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
      const target = event.target;
      const editable = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      const dialogOpen = document.querySelector("dialog[open]") !== null;
      // Focus moves before the key is handled, so the browser types the letter into the box.
      if (startsSearch(event, { editable, dialogOpen })) input.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [input]);
}

export function SymbolSearch({
  symbols,
  selected,
  onSelect,
}: {
  symbols: readonly Security[];
  selected: string | undefined;
  onSelect: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  useTypeAnywhere(input);
  const matches = useMemo(() => matchSymbols(query, symbols), [query, symbols]);

  const choose = (symbol: string) => {
    onSelect(symbol);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const match = matches[active];
      if (open && match) {
        event.preventDefault();
        choose(match.symbol);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div className="search">
      <input
        ref={input}
        className="input search-input"
        role="combobox"
        aria-label="Symbol"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && matches[active] ? `${listId}-${matches[active].symbol}` : undefined}
        placeholder={selected ?? "Symbol"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)} // lets a click on a match land first
        onKeyDown={onKeyDown}
      />
      {open && matches.length > 0 && (
        <ul className="search-list" role="listbox" id={listId}>
          {matches.map((s, i) => (
            <li
              key={s.symbol}
              id={`${listId}-${s.symbol}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "search-option active" : "search-option"}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s.symbol);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <strong>{s.symbol}</strong>
              <span className="muted">{s.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
