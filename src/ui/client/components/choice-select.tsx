import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { createRoot } from "react-dom/client";

// The legacy form owns the value and change handler. Radix owns the trigger,
// keyboard navigation, focus restoration and portalled list.
export function mountChoiceSelect(
  host: HTMLElement,
  source: HTMLSelectElement,
) {
  const panel = document.createElement("div");
  host.append(panel);
  const root = createRoot(panel);
  const labels = Array.from(source.labels ?? []);
  const triggerId = `${source.id}-trigger`;
  const render = () => {
    root.render(
      <Select.Root
        value={source.value}
        disabled={source.disabled}
        onValueChange={(value) => {
          if (!host.getClientRects().length || source.disabled) return;
          const option = Array.from(source.options).find(
            (item) => item.value === value,
          );
          if (!option || option.disabled || option.selected) return;
          source.value = value;
          source.dispatchEvent(new Event("change", { bubbles: true }));
        }}
      >
        <Select.Trigger
          id={triggerId}
          className="choice-trigger"
          aria-describedby={
            source.getAttribute("aria-describedby") ?? undefined
          }
          aria-invalid={
            source.getAttribute("aria-invalid") === "true" || undefined
          }
        >
          <Select.Value />
          <Select.Icon asChild>
            <ChevronDown size={16} aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            collisionPadding={8}
            className="choice-menu"
          >
            <Select.Viewport>
              {Array.from(source.options, (option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="choice-option"
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={16} aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>,
    );
  };
  for (const label of labels) label.htmlFor = triggerId;
  source.hidden = true;
  const observer = new MutationObserver(render);
  observer.observe(source, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  source.addEventListener("change", render);
  render();
  return () => {
    observer.disconnect();
    source.removeEventListener("change", render);
    root.unmount();
    panel.remove();
    source.hidden = false;
    for (const label of labels) label.htmlFor = source.id;
  };
}
