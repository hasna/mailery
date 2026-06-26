import { For, createMemo, createSignal } from "solid-js";
import { TextAttributes, type ColorInput } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { selectedForeground, useTheme } from "../context/theme.js";
import { Button, Row } from "./primitives.js";

export interface SelectDialogItem {
  id: string;
  title: string;
  detail?: string;
  category?: string;
  disabled?: boolean;
  marker?: string;
  markerColor?: ColorInput;
}

function filterItems(items: SelectDialogItem[], query: string): SelectDialogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const parts = q.split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const haystack = `${item.title} ${item.detail ?? ""} ${item.category ?? ""}`.toLowerCase();
    return parts.every((part) => haystack.includes(part));
  });
}

export function SelectDialog(props: {
  title: string;
  placeholder?: string;
  items: SelectDialogItem[];
  query: string;
  onQuery: (value: string) => void;
  onSelect: (item: SelectDialogItem) => void;
  onClose: () => void;
  footer?: string;
}) {
  const theme = useTheme();
  const [active, setActive] = createSignal(0);
  const visible = createMemo(() => filterItems(props.items, props.query));
  const selectActive = () => {
    const item = visible()[active()];
    if (item && !item.disabled) props.onSelect(item);
  };

  useKeyboard((key) => {
    if (key.name === "up") {
      setActive((value) => Math.max(0, value - 1));
      return;
    }
    if (key.name === "down") {
      setActive((value) => Math.min(Math.max(0, visible().length - 1), value + 1));
      return;
    }
    if (key.name === "enter" || key.name === "return") {
      selectActive();
      return;
    }
    if (key.name === "escape") props.onClose();
  });

  return (
    <box flexDirection="column" width="100%" rowGap={1}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>{props.title}</text>
        <Button label="Close" onPress={props.onClose} />
      </box>
      <input
        focused
        value={props.query}
        placeholder={props.placeholder ?? "Filter"}
        width="100%"
        textColor={theme.text}
        backgroundColor={theme.backgroundElement}
        focusedTextColor={theme.text}
        focusedBackgroundColor={theme.backgroundActive}
        placeholderColor={theme.textMuted}
        cursorColor={theme.text}
        onInput={(value) => {
          props.onQuery(value);
          setActive(0);
        }}
      />
      <scrollbox width="100%" height={Math.min(16, Math.max(5, visible().length + 1))}>
        <For each={visible()}>
          {(item, index) => {
            const isActive = () => index() === active();
            return (
              <Row active={isActive()} onPress={() => props.onSelect(item)}>
                <box flexDirection="row" width="100%" columnGap={1} backgroundColor={isActive() ? theme.primary : undefined}>
                  <text fg={isActive() ? selectedForeground(theme, theme.primary) : item.markerColor ?? theme.textMuted}>
                    {item.marker ?? " "}
                  </text>
                  {/* Title takes priority and yields (flexShrink) so it clips cleanly;
                      the detail keeps its natural width (flexShrink={0}) and can never
                      overlap or clip the title text. */}
                  <box flexGrow={1} flexShrink={1}>
                    <text
                      fg={isActive() ? selectedForeground(theme, theme.primary) : item.disabled ? theme.textFaint : theme.text}
                      attributes={isActive() ? TextAttributes.BOLD : 0}
                    >
                      {item.title}
                    </text>
                  </box>
                  {item.detail ? (
                    <box flexShrink={0}>
                      <text fg={isActive() ? selectedForeground(theme, theme.primary) : theme.textMuted}>{item.detail}</text>
                    </box>
                  ) : null}
                </box>
              </Row>
            );
          }}
        </For>
        {visible().length === 0 ? <text fg={theme.textMuted}>No matches</text> : null}
      </scrollbox>
      {props.footer ? <text fg={theme.textMuted}>{props.footer}</text> : null}
    </box>
  );
}
