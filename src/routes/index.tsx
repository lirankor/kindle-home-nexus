import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Home, Sun, Lightbulb, LampCeiling, Sofa, Power, Plug, Tv, Music2, Bot, Play, Pause, SkipBack, SkipForward, Minus, Plus, Moon, Film, RotateCcw, MapPin, Bed, Utensils, Bath, DoorOpen, Baby, ShowerHead, Volume2, Battery, ArrowLeft, Palette, X, Thermometer, Droplets } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DeviceActions, type DeviceAction } from '@/components/device-actions';
import { SpotLightIcon, StripLightIcon } from '@/components/light-icons';
import screensaverPhoto from '@/assets/screensaver-preview.jpg';

export const Route = createFileRoute('/')({
  head: () => ({ meta: [
    { title: 'Home Control · Kindle' },
    { name: 'description', content: 'A 600 × 800 grayscale home control panel with lights, vacuum, power and media views.' },
    { property: 'og:title', content: 'Home Control · Kindle' },
    { property: 'og:description', content: 'Four simple home-control views designed for a non-touch e-ink screen.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: HomeControl,
});

const tabs = [{ name: 'Lights', icon: Lightbulb }, { name: 'Vacuum', icon: Bot }, { name: 'Power', icon: Plug }, { name: 'Media', icon: Music2 }];
const initialLights = [
  { name: 'Main light', room: 'Living room', icon: LampCeiling, on: true, level: 96, shade: 'Warm', color: 'White' },
  { name: 'Spot light', room: 'Living room', icon: on: false, level: 60, shade: 'Neutral', color: 'White' },
  { name: 'Dining table', room: 'Dining room', icon: LampCeiling, on: false, level: 80, shade: 'Warm', color: 'White' },
  { name: 'Cabinet strips', room: 'Dining room', icon: StripLightIcon, on: false, level: 50, shade: 'Cool', color: 'White' },
];
const rooms = [{ name: 'Shower', icon: ShowerHead }, { name: 'Kids room', icon: Baby }, { name: 'Corridor', icon: DoorOpen }, { name: 'Kitchen', icon: Utensils }, { name: 'Hall', icon: Home }, { name: 'Bathroom', icon: Bath }, { name: 'Bedroom', icon: Bed }, { name: 'Living room', icon: Sofa }];

function HomeControl() {
  const [tab, setTab] = useState('Lights');
  const [lights, setLights] = useState(initialLights);
  const [scene, setScene] = useState('');
  const [plugs, setPlugs] = useState([false, true, false]);
  const [selectedRooms, setSelectedRooms] = useState<string[]>([]);
  const [vacuum, setVacuum] = useState('Docked');
  const [notice, setNotice] = useState('Demo · not connected');
  const [locating, setLocating] = useState(false);
  const [screensaver, setScreensaver] = useState(false);
  const [lightMenu, setLightMenu] = useState<{ index: number; mode: 'shade' | 'color' } | null>(null);
  const [dateLabel, setDateLabel] = useState('Tuesday, 6 October');
  const [calendar, setCalendar] = useState({ weekday: 'Tuesday', day: '6', month: 'October', year: '2026' });
  const screen = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setDateLabel(now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }));
      setCalendar({ weekday: now.toLocaleDateString('en-GB', { weekday: 'long' }), day: String(now.getDate()), month: now.toLocaleDateString('en-GB', { month: 'long' }), year: String(now.getFullYear()) });
    };
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setScreensaver(true), 5 * 60 * 1000);
    };
    const wake = (event: Event) => {
      if (screensaver) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setScreensaver(false);
      }
      reset();
    };
    reset();
    document.addEventListener('keydown', wake, true);
    document.addEventListener('pointerdown', wake, true);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', wake, true); document.removeEventListener('pointerdown', wake, true); };
  }, [screensaver]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setLightMenu(null); return; }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        setLightMenu(null);
        const index = tabs.findIndex(item => item.name === tab);
        setTab(tabs[(index + (event.key === 'PageDown' ? 1 : 3)) % 4]?.name ?? 'Lights');
        return;
      }
      const container = screen.current?.querySelector('[role="dialog"]') ?? screen.current;
      const controls = Array.from(container?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const active = document.activeElement;
       if (!(active instanceof HTMLElement) || !controls.includes(active as HTMLButtonElement)) { controls[0]?.focus(); return; }
      const origin = active.getBoundingClientRect();
      const ox = origin.x + origin.width / 2;
      const oy = origin.y + origin.height / 2;
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const sign = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const target = controls.filter(control => control !== active).map(control => {
        const rect = control.getBoundingClientRect();
        const dx = rect.x + rect.width / 2 - ox;
        const dy = rect.y + rect.height / 2 - oy;
        const along = horizontal ? dx : dy;
        const across = horizontal ? dy : dx;
        return { control, along: along * sign, score: Math.abs(along) + Math.abs(across) * 3 };
      }).filter(item => item.along > 2).sort((a, b) => a.score - b.score)[0];
      target?.control.focus();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [tab]);

  useEffect(() => {
    if (lightMenu) screen.current?.querySelector<HTMLButtonElement>('[role="dialog"] button')?.focus();
    else screen.current?.querySelector<HTMLButtonElement>('[data-menu-open="true"]')?.focus();
  }, [lightMenu]);

  const demo = (message: string) => setNotice(`Demo · ${message}`);
  const changeLight = (index: number, amount: number) => {
    setLights(items => items.map((item, i) => i === index ? { ...item, level: Math.max(0, Math.min(100, item.level + amount)), on: true } : item));
    demo('brightness changed');
  };
  const applyScene = (name: string) => {
    setScene(name);
    setLights(items => items.map((item, i) => ({ ...item, on: name === 'Bright' || i === 0, level: name === 'Bright' ? 100 : name === 'Evening' ? 40 : 10 })));
    demo(`${name.toLowerCase()} scene`);
  };

  const allLightsOff = () => { setLights(items => items.map(item => ({ ...item, on: false }))); setScene(''); demo('all lights off'); };
  const togglePlug = (index: number) => { setPlugs(items => items.map((item, i) => i === index ? !item : item)); demo('plug switched'); };
  const plugNames = ['TV Plug', 'Workstation', 'Kitchen boiler'];
  const actions: DeviceAction[] = tab === 'Lights' ? [
    ...[{ name: 'Bright', icon: Sun }, { name: 'Evening', icon: Moon }, { name: 'Movie', icon: Film }].map(({ name, icon }) => ({ label: name, icon, pressed: scene === name, onClick: () => applyScene(name) })),
    { label: 'All off', icon: Power, onClick: allLightsOff },
  ] : tab === 'Vacuum' ? [
    { label: vacuum === 'Cleaning' ? 'Pause cleaning' : 'Start cleaning', icon: vacuum === 'Cleaning' ? Pause : Play, pressed: vacuum === 'Cleaning', onClick: () => { setVacuum(vacuum === 'Cleaning' ? 'Paused' : 'Cleaning'); demo(vacuum === 'Cleaning' ? 'cleaning paused' : 'cleaning started'); } },
    { label: 'Dock', icon: Home, onClick: () => { setVacuum('Docked'); setLocating(false); demo('return to dock'); } },
    { label: 'Locate', icon: MapPin, pressed: locating, onClick: () => { setLocating(!locating); demo('locate vacuum'); } },
    { label: 'Clean all', icon: RotateCcw, onClick: () => { setSelectedRooms([]); setVacuum('Cleaning'); demo('whole home cleaning started'); } },
  ] : tab === 'Power' ? [
    ...plugNames.map((name, index) => ({ label: name, icon: Plug, pressed: plugs[index], onClick: () => togglePlug(index) })),
    { label: 'All off', icon: Power, onClick: () => { setPlugs([false, false, false]); demo('all plugs off'); } },
  ] : [
    { label: 'Yamaha power', icon: Music2, disabled: true, onClick: () => {} },
    { label: 'TV power', icon: Tv, disabled: true, onClick: () => {} },
    { label: 'Movie mode', icon: Film, pressed: scene === 'Movie', onClick: () => applyScene('Movie') },
    { label: 'End movie', icon: ArrowLeft, onClick: () => { setScene(''); demo('movie mode ended'); } },
  ];

  if (screensaver) return <div className="screen-stage"><div className="kindle-screen photo-screen" aria-label="Immich favorites screensaver preview">
    <img src={screensaverPhoto} width={600} height={800} alt="Grayscale alpine lake and mountains — sample screensaver photo" />
    <div className="photo-caption">
      <section className="photo-block"><h2>Outdoor</h2><Sun size={40} strokeWidth={1.5} /><strong className="climate-reading">19.1°</strong><span>Sunny</span></section>
      <section className="photo-block"><h2>Indoor</h2><Thermometer size={40} strokeWidth={1.5} /><strong className="climate-reading">22.0°</strong><span className="humidity-reading"><Droplets size={22} />63%</span></section>
      <section className="photo-block calendar-block" aria-label={dateLabel}><span className="calendar-month">{calendar.month.slice(0, 3).toUpperCase()}</span><strong className="calendar-day">{calendar.day}</strong><span className="calendar-weekday">{calendar.weekday.slice(0, 3).toUpperCase()}</span></section>
      <small className="photo-demo">Demo readings</small>
    </div>
  </div></div>;

  return <div className="screen-stage"><div className="kindle-screen" ref={screen}>
    <nav className="device-tabs" aria-label="Device categories">{tabs.map(({ name, icon: Icon }) => <Button key={name} variant="eink" data-active={tab === name} aria-current={tab === name ? 'page' : undefined} onClick={() => { setTab(name); setLightMenu(null); }}><Icon />{name}</Button>)}</nav>
    <main className="content" key={tab}>
      {tab === 'Lights' && <>
        <div className="section-heading"><div><h1>Lights</h1><p>{lights.filter(light => light.on).length} of 4 lights on</p></div><Button variant="eink" size="icon" title="Screensaver" aria-label="Screensaver" onClick={() => setScreensaver(true)}><Moon /></Button></div>
        <div className="light-card-grid">{lights.map((light, index) => <section className="light-card" key={light.name}>
          <div className="light-card-heading"><Button variant="eink" className="device-icon" title={`${light.name} ${light.on ? 'on' : 'off'}`} aria-label={`Toggle ${light.name}`} aria-pressed={light.on} onClick={() => { setLights(items => items.map((item, i) => i === index ? { ...item, on: !item.on } : item)); setScene(''); demo(`${light.name.toLowerCase()} ${light.on ? 'off' : 'on'}`); }}><light.icon size={32} strokeWidth={1.6} /></Button><div className="device-info"><strong>{light.name}</strong><p>{light.on ? `${light.level}%` : 'Off'} · {light.color === 'White' ? light.shade.toLowerCase() : light.color.toLowerCase()}</p></div></div>
          <p className="light-room">{light.room}</p>
          <div className="light-card-controls"><div className="light-adjustments"><Button variant="eink" title={`${light.shade} white · ${light.name}`} aria-label={`White shade for ${light.name}`} data-menu-open={lightMenu?.index === index && lightMenu.mode === 'shade'} onClick={() => setLightMenu({ index, mode: 'shade' })}><span className={`shade-swatch shade-${light.shade.toLowerCase()}`} /></Button><Button variant="eink" title={`Color · ${light.name}`} aria-label={`Color for ${light.name}`} data-menu-open={lightMenu?.index === index && lightMenu.mode === 'color'} onClick={() => setLightMenu({ index, mode: 'color' })}><Palette /></Button></div><div className="level-control"><Button variant="eink" title={`Dim ${light.name}`} aria-label={`Dim ${light.name}`} onClick={() => changeLight(index, -10)}><Minus /></Button><Button variant="eink" title={`Brighten ${light.name}`} aria-label={`Brighten ${light.name}`} onClick={() => changeLight(index, 10)}><Plus /></Button></div></div>
        </section>)}</div>
      </>}
      {tab === 'Vacuum' && <>
        <div className="section-heading"><div><h1>Vacuum</h1><p>{selectedRooms.length ? `${selectedRooms.length} rooms selected` : 'Whole home'}</p></div><Battery size={24} /></div>
        <div className="vacuum-summary"><Bot strokeWidth={1.3} /><div><strong>Roborock Qrevo Edge</strong><p>{locating ? 'Locating · sound requested' : vacuum}</p></div></div>
        <div className="subheading">Rooms</div><div className="room-grid">{rooms.map(({ name, icon: Icon }) => <Button key={name} variant="eink" aria-pressed={selectedRooms.includes(name)} onClick={() => setSelectedRooms(items => items.includes(name) ? items.filter(item => item !== name) : [...items, name])}><Icon />{name}</Button>)}</div>
        <div className="progress-line"><span>Cleaning progress</span><strong>0%</strong></div><div className="progress-track"><span /></div>
      </>}
      {tab === 'Power' && <>
        <div className="section-heading"><div><h1>Power</h1><p>{plugs.filter(Boolean).length} of 3 plugs on</p></div><Plug size={25} /></div>
        <div className="power-readings">{plugNames.map((name, index) => <div className="power-row" key={name}><div className={`device-icon ${plugs[index] ? 'on' : ''}`}><Plug size={28} /></div><div className="device-info"><strong>{name}</strong><p>{plugs[index] ? 'On' : 'Off'} · {index === 0 ? '244 Wh' : index === 1 ? '569 Wh' : '0 Wh'} today</p></div><strong className="watt-reading">{plugs[index] && index === 1 ? '62.1' : '0.0'} <small>W</small></strong></div>)}</div>
        <section className="usage-chart" aria-label="Demo total power usage graph"><div className="chart-heading"><h2>Total usage</h2><strong>0.813 <small>kWh today</small></strong></div><div className="chart-axis-label">W · demo history</div><svg viewBox="0 0 540 155" role="img" aria-label="Sample total power usage over 24 hours, from 0 to 120 watts"><g className="chart-grid"><path d="M35 10H530M35 70H530M35 130H530" /></g><g className="chart-labels"><text x="0" y="15">120</text><text x="8" y="75">60</text><text x="15" y="135">0</text></g><path className="chart-line" d="M35 128L55 128L76 124L97 127L117 128L138 125L159 98L179 32L200 46L221 86L241 108L262 105L283 110L303 88L324 75L345 92L365 50L386 20L407 62L427 68L448 67L469 68L489 68L510 68L530 68" /></svg><div className="chart-times"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></section>
      </>}
      {tab === 'Media' && <>
        <div className="section-heading"><div><h1>Media</h1><p>Living room</p></div><Music2 size={25} /></div>
        {['Yamaha R-N500', 'Sony TV'].map((name, index) => <section className="media-device" key={name}><div className="media-title">{index === 0 ? <Music2 size={27} /> : <Tv size={27} />}<div><strong>{name}</strong><p>Unavailable</p></div></div>
          <div className="transport">{[{ icon: SkipBack, label: 'Previous' }, { icon: Play, label: 'Play' }, { icon: Pause, label: 'Pause' }, { icon: SkipForward, label: 'Next' }].map(({ icon: Icon, label }) => <Button variant="eink" disabled key={label} title={label} aria-label={`${label} on ${name}`}><Icon /></Button>)}</div>
          <div className="source-control"><span>Source</span><span>—</span></div><div className="source-control"><span><Volume2 size={16} /> Volume</span><div className="level-control"><Button variant="eink" disabled aria-label={`Lower volume on ${name}`}><Minus /></Button><span className="level-value">—</span><Button variant="eink" disabled aria-label={`Raise volume on ${name}`}><Plus /></Button></div></div>
        </section>)}
      </>}
    </main>
    <div className="demo-status" role="status">{notice}</div>
    <DeviceActions actions={actions} />
    {lightMenu && <div className="light-menu-backdrop"><section role="dialog" aria-modal="true" aria-label={`${lightMenu.mode === 'shade' ? 'White shade' : 'Color'} for ${lights[lightMenu.index]?.name}`} className="light-menu"><div className="menu-heading"><div><h2>{lightMenu.mode === 'shade' ? 'White shade' : 'Color'}</h2><p>{lights[lightMenu.index]?.name} · demo</p></div><Button variant="eink" size="icon" aria-label="Close light menu" onClick={() => setLightMenu(null)}><X /></Button></div><div className="color-options">{(lightMenu.mode === 'shade' ? ['Warm', 'Neutral', 'Cool'] : ['White', 'Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Purple', 'Pink']).map(value => <Button key={value} variant="eink" aria-pressed={lightMenu.mode === 'shade' ? lights[lightMenu.index]?.shade === value && lights[lightMenu.index]?.color === 'White' : lights[lightMenu.index]?.color === value} onClick={() => { setLights(items => items.map((item, i) => i === lightMenu.index ? { ...item, ...(lightMenu.mode === 'shade' ? { shade: value, color: 'White' } : { color: value }) } : item)); demo(`${value.toLowerCase()} selected`); setLightMenu(null); }}>{lightMenu.mode === 'shade' ? <span className={`shade-swatch shade-${value.toLowerCase()}`} /> : <Palette />}<span>{value}</span></Button>)}</div></section></div>}
  </div></div>;
}