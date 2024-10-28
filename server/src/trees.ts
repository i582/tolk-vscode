import { LRUMap } from './utils/lruMap';
import * as lsp from 'vscode-languageserver';
import * as Parser from 'web-tree-sitter';
import { Disposable, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentStore, TextDocumentChange2 } from './documentStore';
import { createParser } from './parser';

class Entry {
  constructor(
    public version: number,
    public tree: Parser.Tree,
    public edits: Parser.Edit[][]
  ) {
  }
}

export type ParseDone = {
  tree: Parser.Tree,
  document: TextDocument
}

export class Trees {

  private readonly _cache = new LRUMap<string, Entry>({
    size: 200,
    dispose(entries) {
      for (let [, value] of entries) {
        value.tree.delete();
      }
    }
  });

  private readonly _listener: Disposable[] = [];
  private readonly _parser = createParser();
  private readonly _onParseDone = new lsp.Emitter<ParseDone>();
  readonly onParseDone = this._onParseDone.event;

  constructor(private readonly _documents: DocumentStore) {
    // build edits when document changes
    this._listener.push(_documents.onDidChangeContent2(e => {
      const info = this._cache.get(e.document.uri);
      if (info) {
        info.edits.push(Trees._asEdits(e));
      }
    }));
  }

  dispose(): void {
    for (let item of this._cache.values()) {
      item.tree.delete();
    }
    for (let item of this._listener) {
      item.dispose();
    }
  }

  // --- tree/parse

  getParseTree(documentOrUri: string): Promise<Parser.Tree | undefined>;
  getParseTree(documentOrUri: TextDocument): Parser.Tree | undefined;
  getParseTree(documentOrUri: TextDocument | string): Promise<Parser.Tree | undefined> | Parser.Tree | undefined {
    if (typeof documentOrUri === 'string') {
      return this._documents.retrieve(documentOrUri).then(doc => {
        if (!doc.exists) {
          return undefined;
        }
        return this._parse(doc.document);
      });
    } else {
      return this._parse(documentOrUri);
    }
  }

  private _parse(documentOrUri: TextDocument): Parser.Tree | undefined {
    let info = this._cache.get(documentOrUri.uri);
    if (info?.version === documentOrUri.version) {
      return info.tree;
    }

    try {
      const version = documentOrUri.version;
      const text = documentOrUri.getText();

      if (!info) {
        // never seen before, parse fresh
        const tree = this._parser.parse(text);
        info = new Entry(version, tree, []);
        this._cache.set(documentOrUri.uri, info);

      } else {
        // existing entry, apply deltas and parse incremental
        const oldTree = info.tree;
        const deltas = info.edits.flat();
        deltas.forEach(delta => oldTree.edit(delta));
        info.edits.length = 0;

        info.tree = this._parser.parse(text, oldTree);
        info.version = version;
        oldTree.delete();
      }

      this._onParseDone.fire({
        document: documentOrUri,
        tree: info.tree
      })

      return info.tree;

    } catch (e) {
      this._cache.delete(documentOrUri.uri);
      return undefined;
    }
  }

  private static _asEdits(event: TextDocumentChange2): Parser.Edit[] {
    return event.changes.map(change => ({
      startPosition: this._asTsPoint(change.range.start),
      oldEndPosition: this._asTsPoint(change.range.end),
      newEndPosition: this._asTsPoint(event.document.positionAt(change.rangeOffset + change.text.length)),
      startIndex: change.rangeOffset,
      oldEndIndex: change.rangeOffset + change.rangeLength,
      newEndIndex: change.rangeOffset + change.text.length
    }));
  }

  private static _asTsPoint(position: Position): Parser.Point {
    const { line: row, character: column } = position;
    return { row, column };
  }
};
