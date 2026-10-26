import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Find and Replace: every match of the search is marked, the current one more strongly; Next and
 * Previous move the selection through them (and scroll there); Replace and Replace All change
 * them. Matches never span two paragraphs, as in Word.
 */

interface FindState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: { from: number; to: number }[];
  current: number;
  decorations: DecorationSet;
}

export const findKey = new PluginKey<FindState>("findReplace");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    findReplace: {
      setSearch: (query: string, options?: { caseSensitive?: boolean; wholeWord?: boolean }) => ReturnType;
      findNext: () => ReturnType;
      findPrevious: () => ReturnType;
      replaceCurrent: (text: string) => ReturnType;
      replaceAll: (text: string) => ReturnType;
      clearSearch: () => ReturnType;
    };
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAll(doc: PMNode, query: string, caseSensitive: boolean, wholeWord: boolean): { from: number; to: number }[] {
  if (!query) return [];
  const pattern = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${escape(query)}(?![\\p{L}\\p{N}_])` : escape(query), caseSensitive ? "gu" : "giu");
  const found: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // The block's text with each character's document position (inline atoms count as one).
    let text = "";
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) {
          text += child.text![i];
          at.push(pos + 1 + offset + i);
        }
      } else {
        text += "￼";
        at.push(pos + 1 + offset);
      }
    });
    for (const m of text.matchAll(pattern)) {
      if (!m[0].length) continue;
      const start = m.index!;
      found.push({ from: at[start], to: at[start + m[0].length - 1] + 1 });
    }
    return false;
  });
  return found;
}

function decorate(doc: PMNode, matches: { from: number; to: number }[], current: number): DecorationSet {
  return DecorationSet.create(doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? "dc-find-hit current" : "dc-find-hit" })));
}

function nearest(matches: { from: number; to: number }[], pos: number): number {
  const i = matches.findIndex((m) => m.from >= pos);
  return i < 0 ? (matches.length ? 0 : -1) : i;
}

type Meta = { query: string; caseSensitive: boolean; wholeWord: boolean } | { current: number };

export function findState(state: EditorState): FindState | undefined {
  return findKey.getState(state);
}

export const FindReplace = Extension.create({
  name: "findReplace",
  addProseMirrorPlugins() {
    return [new Plugin<FindState>({
      key: findKey,
      state: {
        init: () => ({ query: "", caseSensitive: false, wholeWord: false, matches: [], current: -1, decorations: DecorationSet.empty }),
        apply(tr: Transaction, prev: FindState, _old: EditorState, state: EditorState): FindState {
          const meta = tr.getMeta(findKey) as Meta | undefined;
          if (meta && "query" in meta) {
            const matches = findAll(state.doc, meta.query, meta.caseSensitive, meta.wholeWord);
            const current = nearest(matches, state.selection.from);
            return { ...meta, matches, current, decorations: decorate(state.doc, matches, current) };
          }
          if (meta && "current" in meta) return { ...prev, current: meta.current, decorations: decorate(state.doc, prev.matches, meta.current) };
          if (tr.docChanged && prev.query) {
            const matches = findAll(state.doc, prev.query, prev.caseSensitive, prev.wholeWord);
            const current = Math.min(prev.current, matches.length - 1);
            return { ...prev, matches, current, decorations: decorate(state.doc, matches, current) };
          }
          return prev;
        },
      },
      props: {
        decorations: (state) => findKey.getState(state)?.decorations,
      },
    })];
  },
  addCommands() {
    const go = (step: number) => ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: (tr: Transaction) => void }) => {
      const s = findKey.getState(state);
      if (!s || !s.matches.length) return false;
      const current = s.current < 0 ? 0 : (s.current + step + s.matches.length) % s.matches.length;
      const m = s.matches[current];
      if (dispatch) dispatch(tr.setSelection(TextSelection.create(state.doc, m.from, m.to)).setMeta(findKey, { current }).scrollIntoView());
      return true;
    };
    return {
      setSearch: (query, options = {}) => ({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(findKey, { query, caseSensitive: !!options.caseSensitive, wholeWord: !!options.wholeWord }));
        return true;
      },
      findNext: () => go(1),
      findPrevious: () => go(-1),
      replaceCurrent: (text) => ({ state, tr, dispatch }) => {
        const s = findKey.getState(state);
        if (!s || s.current < 0 || !s.matches[s.current]) return false;
        const m = s.matches[s.current];
        if (dispatch) {
          tr.insertText(text, m.from, m.to);
          dispatch(tr);
        }
        return true;
      },
      replaceAll: (text) => ({ state, tr, dispatch }) => {
        const s = findKey.getState(state);
        if (!s || !s.matches.length) return false;
        if (dispatch) {
          // From the end, so earlier positions stay right.
          for (const m of [...s.matches].reverse()) tr.insertText(text, m.from, m.to);
          dispatch(tr);
        }
        return true;
      },
      clearSearch: () => ({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(findKey, { query: "", caseSensitive: false, wholeWord: false }));
        return true;
      },
    };
  },
});
