'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type SettingDescriptor } from '../../lib/api';
import { Badge, Button, Card, Empty, ErrorText, Field } from '../../components/ui';

const GROUPS: { key: string; title: string; standfirst: string }[] = [
  {
    key: 'queue',
    title: 'Queue',
    standfirst: 'How much runs at once, and whether anything runs at all.',
  },
  {
    key: 'usage',
    title: 'Usage',
    standfirst: 'The ceiling your usage is measured against. The engine does not report the account limit.',
  },
  {
    key: 'agents',
    title: 'Agents',
    standfirst: 'What the agents are allowed to spend and how deeply they work.',
  },
  {
    key: 'integration',
    title: 'GitHub',
    standfirst: 'What is needed before a finished story can become a pull request.',
  },
  {
    key: 'chat',
    title: 'Chat',
    standfirst: 'What the chat window may do in a project directory.',
  },
];

const SOURCE_WORDS: Record<SettingDescriptor['source'], string> = {
  stored: 'set here',
  environment: 'from the environment',
  default: 'default',
};

/**
 * The settings a person may change while the system runs.
 *
 * Generated from the descriptors the API serves rather than written out here, so
 * a new setting appears with its own explanation instead of as an unlabelled box.
 * Everything not on this page is an environment variable a restart would have to
 * follow anyway.
 */
export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingDescriptor[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ settings: SettingDescriptor[] }>('/api/settings');
      setSettings(result.settings);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (Object.keys(edits).length === 0) return;
    setBusy(true);
    try {
      const result = await api.put<{ settings: SettingDescriptor[] }>('/api/settings', { values: edits });
      setSettings(result.settings);
      setEdits({});
      setSaved(true);
      setError(null);
      setTimeout(() => setSaved(false), 4000);
    } catch (putError) {
      setError(putError instanceof Error ? putError.message : String(putError));
    } finally {
      setBusy(false);
    }
  }

  async function clear(key: string) {
    setBusy(true);
    try {
      const result = await api.delete<{ settings: SettingDescriptor[] }>(`/api/settings/${encodeURIComponent(key)}`);
      setSettings(result.settings);
      setEdits((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  function control(setting: SettingDescriptor) {
    const pending = edits[setting.key];
    const value = pending ?? setting.value;

    if (setting.kind === 'boolean') {
      const on = (pending ?? setting.value).toLowerCase() === 'true';
      return (
        <div className="row">
          <Button
            size="sm"
            variant={on ? 'primary' : 'secondary'}
            onClick={() => setEdits({ ...edits, [setting.key]: on ? 'false' : 'true' })}
          >
            {on ? 'On' : 'Off'}
          </Button>
        </div>
      );
    }

    if (setting.kind === 'choice') {
      return (
        <div className="choices">
          {setting.choices?.map((choice) => (
            <button
              key={choice.value}
              className={`choice ${value === choice.value ? 'selected' : ''}`}
              onClick={() => setEdits({ ...edits, [setting.key]: choice.value })}
            >
              <span className="choice-label">{choice.label}</span>
              <span className="choice-detail">{choice.help}</span>
            </button>
          ))}
        </div>
      );
    }

    if (setting.kind === 'secret') {
      return (
        <Field hint={setting.isSet ? 'A value is set. Typing a new one replaces it.' : 'No value is set.'}>
          <input
            type="password"
            placeholder={setting.isSet ? '••••••••••••' : 'paste the token'}
            value={pending ?? ''}
            onChange={(event) => setEdits({ ...edits, [setting.key]: event.target.value })}
          />
        </Field>
      );
    }

    return (
      <Field>
        <input
          type={setting.kind === 'integer' ? 'number' : 'text'}
          value={value}
          min={setting.min}
          max={setting.max}
          onChange={(event) => setEdits({ ...edits, [setting.key]: event.target.value })}
        />
      </Field>
    );
  }

  const dirty = Object.keys(edits).length;

  return (
    <div className="page enter">
      <div className="row-between">
        <div className="grow">
          <h1 className="display">Settings</h1>
          <p className="standfirst">
            These take effect on the next thing that reads them, without a restart. Anything not here is an environment
            variable a restart would have to follow anyway.
          </p>
        </div>
        <div className="row">
          <Button onClick={() => void save()} disabled={busy || dirty === 0}>
            {dirty === 0 ? 'Nothing to save' : `Save ${dirty} change${dirty === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {saved ? <span className="meta">Saved.</span> : null}

      {settings.length === 0 ? <Empty>Reading the settings.</Empty> : null}

      {GROUPS.map((group) => {
        const own = settings.filter((setting) => setting.group === group.key);
        if (own.length === 0) return null;
        return (
          <section className="stack" key={group.key}>
            <div>
              <h2 className="subhead">{group.title}</h2>
              <p className="standfirst">{group.standfirst}</p>
            </div>
            {own.map((setting) => (
              <Card key={setting.key}>
                <div className="row-between">
                  <span className="list-title">{setting.label}</span>
                  <div className="row">
                    <Badge tone={setting.source === 'stored' ? 'done' : undefined}>{SOURCE_WORDS[setting.source]}</Badge>
                    {setting.source === 'stored' ? (
                      <Button size="sm" variant="ghost" onClick={() => void clear(setting.key)} disabled={busy}>
                        Reset
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="body-sm">{setting.help}</p>
                {control(setting)}
              </Card>
            ))}
          </section>
        );
      })}
    </div>
  );
}
