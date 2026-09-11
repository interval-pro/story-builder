'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Every multi-line input in the cockpit is this component, and it never passes
 * a `value` prop. A `value` prop lets any render write React's idea of the text
 * back onto the element, and these pages re-render on a poll, so a long paste
 * can lose the characters that landed between the paste and the render. With
 * the element as the only authority the text cannot be overwritten at all.
 *
 * The consequence is that nothing outside the element knows the draft between
 * renders. Callers get a trimmed length to keep a submit button reactive, and
 * read the real text off the element at submit time.
 */
interface Props {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  rows: number;
  placeholder: string;
  onLengthChange?: (length: number) => void;
  /** Keeps a half-written draft across an unmount, for inputs that come and go. */
  retain?: RefObject<string>;
}

export function DraftTextarea({ textareaRef, rows, placeholder, onLengthChange, retain }: Props) {
  // Read once at mount: React syncs a *changed* defaultValue onto a pristine
  // field, which would be the same write-back this component exists to remove.
  const initial = useRef(retain?.current ?? '');

  useEffect(() => {
    // Hold the element itself rather than reading the ref from the cleanup.
    // React detaches a deleted subtree's host refs during the mutation phase,
    // so by the time a passive cleanup runs textareaRef.current is already
    // null and the draft would be dropped instead of retained.
    const element = textareaRef.current;
    return () => {
      // The element is the complete text by construction. Reconstructing it
      // from change events would reintroduce the loss one indirection later.
      if (retain && element) retain.current = element.value;
    };
  }, [retain, textareaRef]);

  return (
    <textarea
      ref={textareaRef}
      rows={rows}
      placeholder={placeholder}
      defaultValue={initial.current}
      onChange={(event) => onLengthChange?.(event.target.value.trim().length)}
    />
  );
}
