import { Fragment } from "react";
import { splitHighlight } from "../utils/chat-search";

export function SearchHighlight(props: { text: string; keywords: string[] }) {
  return (
    <>
      {splitHighlight(props.text, props.keywords).map((part, index) =>
        part.matched ? (
          <mark key={index}>{part.text}</mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
