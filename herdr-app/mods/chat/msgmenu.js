// A message's right-click menu, opened by a chat as a popup at the pointer (main.js openMessageMenu): selcopy.js
// messageMenuItems, each with the text it copies.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { closeOverlay, props, theme } from "herdr";

export class MessageMenu {
  /** @param {{ items?: { id: string, label: string, text: string }[] }} menu */
  constructor(menu) {
    this.items = Array.isArray(menu?.items) ? menu.items : [];
  }

  render() {
    const t = theme();
    let view = v_flex().id("chat-msg-menu").w_full().p(4).text_size(12.5).text_color(t.foreground);
    for (const item of this.items)
      view = view.child(div().id(`chat-msg-menu-${item.id}`).flex_none().h(26).px(10).flex().items_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.write_to_clipboard(item.text); closeOverlay(String(props()?.overlay ?? "")); })
        .child(div().truncate().child(item.label)));
    return view;
  }
}
