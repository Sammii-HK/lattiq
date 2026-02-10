"use client";

import { useCallback, useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  ParagraphNode,
} from "lexical";
import { $isHeadingNode, $createHeadingNode } from "@lexical/rich-text";
import type { HeadingTagType } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import { $createQuoteNode, $isQuoteNode } from "@lexical/rich-text";
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { TOGGLE_LINK_COMMAND, $isLinkNode } from "@lexical/link";
import { $findMatchingParent } from "@lexical/utils";
import { $isRootOrShadowRoot } from "lexical";

type BlockType =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "ul"
  | "ol"
  | "quote"
  | "code";

export default function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [isLink, setIsLink] = useState(false);
  const [blockType, setBlockType] = useState<BlockType>("paragraph");

  const updateToolbar = useCallback(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    setIsBold(selection.hasFormat("bold"));
    setIsItalic(selection.hasFormat("italic"));
    setIsUnderline(selection.hasFormat("underline"));

    const anchorNode = selection.anchor.getNode();
    let element =
      anchorNode.getKey() === "root"
        ? anchorNode
        : $findMatchingParent(anchorNode, (e) => {
            const parent = e.getParent();
            return parent !== null && $isRootOrShadowRoot(parent);
          });

    if (element === null) {
      element = anchorNode.getTopLevelElementOrThrow();
    }

    // Detect block type
    if ($isHeadingNode(element)) {
      setBlockType(element.getTag() as BlockType);
    } else if ($isListNode(element)) {
      const listType = element.getListType();
      setBlockType(listType === "number" ? "ol" : "ul");
    } else if ($isQuoteNode(element)) {
      setBlockType("quote");
    } else if ($isCodeNode(element)) {
      setBlockType("code");
    } else {
      setBlockType("paragraph");
    }

    // Detect link
    const node = selection.anchor.getNode();
    const parent = node.getParent();
    setIsLink($isLinkNode(parent) || $isLinkNode(node));
  }, []);

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        updateToolbar();
        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor, updateToolbar]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        updateToolbar();
      });
    });
  }, [editor, updateToolbar]);

  const formatHeading = (tag: HeadingTagType) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (blockType === tag) {
        // Toggle off — revert to paragraph
        $setBlocksType(selection, () => {
          return new ParagraphNode();
        });
      } else {
        $setBlocksType(selection, () => $createHeadingNode(tag));
      }
    });
  };

  const formatList = (type: "ul" | "ol") => {
    if (blockType === type) {
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    } else {
      editor.dispatchCommand(
        type === "ul"
          ? INSERT_UNORDERED_LIST_COMMAND
          : INSERT_ORDERED_LIST_COMMAND,
        undefined
      );
    }
  };

  const formatQuote = () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (blockType === "quote") {
        $setBlocksType(selection, () => {
          return new ParagraphNode();
        });
      } else {
        $setBlocksType(selection, () => $createQuoteNode());
      }
    });
  };

  const formatCode = () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (blockType === "code") {
        $setBlocksType(selection, () => {
          return new ParagraphNode();
        });
      } else {
        $setBlocksType(selection, () => $createCodeNode());
      }
    });
  };

  const insertLink = () => {
    if (isLink) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
    } else {
      const url = window.prompt("Enter URL:");
      if (url) {
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
      }
    }
  };

  return (
    <div className="editor-toolbar">
      <button
        type="button"
        className={`toolbar-btn${isBold ? " active" : ""}`}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
        aria-label="Bold"
        title="Bold"
      >
        B
      </button>
      <button
        type="button"
        className={`toolbar-btn${isItalic ? " active" : ""}`}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
        aria-label="Italic"
        title="Italic"
      >
        I
      </button>
      <button
        type="button"
        className={`toolbar-btn${isUnderline ? " active" : ""}`}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
        aria-label="Underline"
        title="Underline"
      >
        U
      </button>

      <div className="toolbar-divider" />

      <button
        type="button"
        className={`toolbar-btn${blockType === "h1" ? " active" : ""}`}
        onClick={() => formatHeading("h1")}
        aria-label="Heading 1"
        title="Heading 1"
      >
        H1
      </button>
      <button
        type="button"
        className={`toolbar-btn${blockType === "h2" ? " active" : ""}`}
        onClick={() => formatHeading("h2")}
        aria-label="Heading 2"
        title="Heading 2"
      >
        H2
      </button>
      <button
        type="button"
        className={`toolbar-btn${blockType === "h3" ? " active" : ""}`}
        onClick={() => formatHeading("h3")}
        aria-label="Heading 3"
        title="Heading 3"
      >
        H3
      </button>

      <div className="toolbar-divider" />

      <button
        type="button"
        className={`toolbar-btn${blockType === "ul" ? " active" : ""}`}
        onClick={() => formatList("ul")}
        aria-label="Bullet List"
        title="Bullet List"
      >
        UL
      </button>
      <button
        type="button"
        className={`toolbar-btn${blockType === "ol" ? " active" : ""}`}
        onClick={() => formatList("ol")}
        aria-label="Numbered List"
        title="Numbered List"
      >
        OL
      </button>

      <div className="toolbar-divider" />

      <button
        type="button"
        className={`toolbar-btn${blockType === "code" ? " active" : ""}`}
        onClick={formatCode}
        aria-label="Code Block"
        title="Code Block"
      >
        Code
      </button>
      <button
        type="button"
        className={`toolbar-btn${blockType === "quote" ? " active" : ""}`}
        onClick={formatQuote}
        aria-label="Block Quote"
        title="Block Quote"
      >
        Quote
      </button>

      <div className="toolbar-divider" />

      <button
        type="button"
        className={`toolbar-btn${isLink ? " active" : ""}`}
        onClick={insertLink}
        aria-label="Link"
        title="Link"
      >
        Link
      </button>
    </div>
  );
}
