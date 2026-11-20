import { useState } from 'react';
import { sendPrompt, setPanel } from '../state/ai';
import { Icon } from '../components/Icon';

/**
 * The global command field. Enter starts a new task with the current mode, using the active version
 * and selection as context; the conversation opens in the Assistant panel.
 */
export function CommandField() {
  const [text, setText] = useState('');
  return (
    <form
      className="command-field"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const value = text.trim();
        if (!value) {
          setPanel('assistant');
          return;
        }
        setText('');
        void sendPrompt(value, { newTask: true });
      }}
    >
      <Icon name="search" size={14} />
      <input
        className="command-input"
        aria-label="What do you want to create or change?"
        placeholder="What do you want to create or change?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setText('');
        }}
      />
      <kbd className="command-kbd">Ctrl K</kbd>
    </form>
  );
}
