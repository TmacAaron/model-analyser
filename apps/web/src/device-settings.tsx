import { useState } from 'react';
import { AssetDocument, type AssetRef, type Scenario } from '@model-analyser/contracts';
import { HardwareEditor, hardwareEditorAsset } from './hardware-editor.js';
import { useDisplayUnits } from './display-units.js';

type HardwareChoice = { ref: AssetRef; name: string };
type HardwareDraft = NonNullable<ReturnType<typeof hardwareEditorAsset>>;
type Props = {
  scenario: Scenario;
  snapshots: AssetDocument[];
  choices: HardwareChoice[];
  onHardware: (ref: AssetRef) => Promise<void>;
  onCustom: (scenario: Scenario, assets: AssetDocument[]) => void;
};

const key = (ref: AssetRef) => ref.assetId + '@' + ref.revision;

export function DeviceSettings({ scenario, snapshots, choices, onHardware, onCustom }: Props) {
  const display = useDisplayUnits();
  const devices = scenario.deviceTopology.devices;
  const first = devices[0]?.hardware;
  const sameProfile = first && devices.every(device => key(device.hardware) === key(first));
  const profile = first && snapshots.find(asset => asset.assetId === first.assetId && asset.revision === first.revision);
  const [draft, setDraft] = useState<HardwareDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function selectProfile(id: string) {
    const choice = choices.find(item => key(item.ref) === id);
    if (!choice) return;
    setError('');
    setBusy(true);
    try {
      await onHardware(choice.ref);
      setDraft(undefined);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(false);
    }
  }

  function beginCustom() {
    if (!profile) return;
    const custom = hardwareEditorAsset(JSON.stringify({ ...profile, name: profile.name + '（自定义）' }));
    if (!custom) return;
    setError('');
    setDraft(custom);
  }

  function applyCustom() {
    if (!draft) return;
    const value = AssetDocument.safeParse({ ...draft, assetId: 'user:hardware:' + crypto.randomUUID(), revision: 1 });
    if (!value.success || value.data.definition.kind !== 'hardware') {
      setError('请填写有效的设备名称、容量及能力参数。');
      return;
    }
    const asset = value.data;
    const hardware = { kind: 'hardware' as const, assetId: asset.assetId, revision: asset.revision };
    try {
      onCustom({
        ...scenario,
        deviceTopology: { ...scenario.deviceTopology, devices: devices.map(device => ({ ...device, hardware })) },
      }, [asset]);
      setDraft(undefined);
      setError('');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    }
  }

  return <section className="device-settings">
    <label>设备型号<select aria-label="设备型号" value={sameProfile ? key(first) : ''} disabled={busy} onChange={event => void selectProfile(event.target.value)}>
      {!sameProfile && <option value="" disabled>选择统一型号</option>}
      {choices.map(choice => <option key={key(choice.ref)} value={key(choice.ref)}>{choice.name} · r{choice.ref.revision}</option>)}
    </select></label>
    <p><strong>{devices.length} 卡</strong>{sameProfile && profile?.definition.kind === 'hardware' && ' · ' + display.bytes(profile.definition.hardware.capacityBytes) + ' / 卡'}</p>
    {draft
      ? <>
        <HardwareEditor asset={draft} onChange={setDraft} projectProfile/>
        <button type="button" onClick={applyCustom} disabled={busy}>应用自定义参数</button>
        <button type="button" onClick={() => { setDraft(undefined); setError(''); }}>取消</button>
      </>
      : <button type="button" onClick={beginCustom} disabled={!profile || busy}>自定义参数</button>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
