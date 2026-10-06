import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Home, Sun, Lightbulb, LampCeiling, LampDesk, Sofa, Power, Plug, Tv, Music2, Bot, Play, Pause, SkipBack, SkipForward, Minus, Plus, Moon, Film, RotateCcw, MapPin, Bed, Utensils, Bath, DoorOpen, Baby, ShowerHead, Volume2, Battery, Check, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
  { name: 'Main light', room: 'Living room', icon: LampCeiling, on: true, level: 96 },
  { name: 'Spot light', room: 'Living room', icon: LampDesk, on: false, level: 60 },
  { name: 'Dining table', room: 'Dining room', icon: LampCeiling, on: false, level: 80 },
  { name: 'Cabinet strips', room: 'Dining room', icon: Lightbulb, on: false, level: 50 },
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
  const screen = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        const index = tabs.findIndex(item => item.name === tab);
        setTab(tabs[(index + (event.key === 'PageDown' ? 1 : 3)) % 4].name);
        return;
      }
      const controls = Array.from(screen.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !controls.includes(active as HTMLButtonElement)) { controls[4]?.focus(); return; }
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

  return <div className="screen-stage"><div className="kindle-screen" ref={screen}>
    <header className="home-header">
      <div className="brand"><Home size={26} strokeWidth={1.7} />Home</div>
      <div className="header-status"><div className="status-line"><span className="status-dot" />HOME ASSISTANT</div><div>Tuesday, 6 October</div></div>
    </header>
    <section className="climate" aria-label="Home conditions">
      <div className="weather"><Sun size={36} strokeWidth={1.4} /><div><strong>19.1°</strong><small>Sunny outside</small></div></div>
      <div className="climate-stat"><strong>22.0<span> °C</span></strong><small>INDOOR</small></div>
      <div className="climate-stat"><strong>63<span> %</span></strong><small>HUMIDITY</small></div>
    </section>
    <nav className="device-tabs" aria-label="Device categories">{tabs.map(({ name, icon: Icon }) => <Button key={name} variant="eink" data-active={tab === name} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}><Icon />{name}</Button>)}</nav>
    <main className="content" key={tab}>
      {tab === 'Lights' && <>
        <div className="section-heading"><div><h1>Lights</h1><p>{lights.filter(light => light.on).length} of 4 lights on</p></div><Button variant="eink" onClick={() => { setLights(items => items.map(item => ({ ...item, on: false }))); setScene(''); demo('all lights off'); }}><Power />All off</Button></div>
        {lights.map((light, index) => <div key={light.name}>
          {(index === 0 || index === 2) && <div className="group-label">{light.room}</div>}
          <div className="light-row"><div className={`device-icon ${light.on ? 'on' : ''}`}><light.icon size={24} strokeWidth={1.5} /></div>
            <div className="device-info"><strong>{light.name}</strong><p>{light.on ? `${light.level}% brightness` : 'Off'}</p></div>
            <div className="level-control"><Button variant="eink" title={`Dim ${light.name}`} aria-label={`Dim ${light.name}`} onClick={() => changeLight(index, -10)}><Minus /></Button><span className="level-value">{light.on ? `${light.level}%` : '—'}</span><Button variant="eink" title={`Brighten ${light.name}`} aria-label={`Brighten ${light.name}`} onClick={() => changeLight(index, 10)}><Plus /></Button></div>
            <Button variant="eink" className="toggle-button" aria-label={`Toggle ${light.name}`} aria-pressed={light.on} onClick={() => { setLights(items => items.map((item, i) => i === index ? { ...item, on: !item.on } : item)); setScene(''); demo(`${light.name.toLowerCase()} ${light.on ? 'off' : 'on'}`); }}>{light.on ? 'On' : 'Off'}</Button>
          </div></div>)}
        <div className="subheading">Scenes</div><div className="scene-grid">{[{ name: 'Bright', icon: Sun }, { name: 'Evening', icon: Moon }, { name: 'Movie', icon: Film }].map(({ name, icon: Icon }) => <Button key={name} variant="eink" aria-pressed={scene === name} onClick={() => applyScene(name)}><Icon />{name}</Button>)}</div>
      </>}
      {tab === 'Vacuum' && <>
        <div className="section-heading"><div><h1>Vacuum</h1><p>{selectedRooms.length ? `${selectedRooms.length} rooms selected` : 'Whole home'}</p></div><Battery size={24} /></div>
        <div className="vacuum-summary"><Bot strokeWidth={1.3} /><div><strong>Roborock Qrevo Edge</strong><p>{locating ? 'Locating · sound requested' : vacuum}</p></div></div>
        <div className="vacuum-actions"><Button variant="eink" aria-pressed={vacuum === 'Cleaning'} onClick={() => { setVacuum(vacuum === 'Cleaning' ? 'Paused' : 'Cleaning'); demo(vacuum === 'Cleaning' ? 'cleaning paused' : 'cleaning started'); }}>{vacuum === 'Cleaning' ? <Pause /> : <Play />}{vacuum === 'Cleaning' ? 'Pause' : 'Start cleaning'}</Button><Button variant="eink" onClick={() => { setVacuum('Docked'); demo('return to dock'); }}><Home />Dock</Button><Button variant="eink" onClick={() => { setLocating(!locating); demo('locate vacuum'); }}><MapPin />Locate</Button></div>
        <div className="subheading">Rooms</div><div className="room-grid">{rooms.map(({ name, icon: Icon }) => <Button key={name} variant="eink" aria-pressed={selectedRooms.includes(name)} onClick={() => setSelectedRooms(items => items.includes(name) ? items.filter(item => item !== name) : [...items, name])}><Icon />{name}</Button>)}<Button variant="eink" onClick={() => setSelectedRooms([])}><RotateCcw />Whole home</Button></div>
        <div className="progress-line"><span>Cleaning progress</span><strong>0%</strong></div><div className="progress-track"><span /></div>
      </>}
      {tab === 'Power' && <>
        <div className="section-heading"><div><h1>Power</h1><p>{plugs.filter(Boolean).length} of 3 plugs on</p></div><Plug size={25} /></div>
        <div className="group-label">Plugs & power</div>{['TV Plug', 'Workstation', 'Kitchen boiler'].map((name, index) => <div className="light-row" key={name}><div className={`device-icon ${plugs[index] ? 'on' : ''}`}><Plug size={24} /></div><div className="device-info"><strong>{name}</strong><p>{plugs[index] ? 'On' : 'Off'} · {plugs[index] && index === 1 ? '62.1' : '0.0'} W</p></div><Button variant="eink" className="toggle-button" aria-label={`Toggle ${name}`} aria-pressed={plugs[index]} onClick={() => { setPlugs(items => items.map((item, i) => i === index ? !item : item)); demo(`${name.toLowerCase()} switched`); }}>{plugs[index] ? 'On' : 'Off'}</Button></div>)}
        <div className="subheading">Energy today</div><div className="power-stats"><div><strong>569<small> Wh</small></strong><small>Workstation</small></div><div><strong>244<small> Wh</small></strong><small>TV Plug</small></div><div><strong>0.00<small> kWh</small></strong><small>Kitchen boiler</small></div></div>
        <div className="subheading">Total today</div><div className="power-stats"><div><strong>0.813<small> kWh</small></strong><small>Across all plugs</small></div></div>
      </>}
      {tab === 'Media' && <>
        <div className="section-heading"><div><h1>Media</h1><p>Living room</p></div><Music2 size={25} /></div>
        <div className="scene-grid"><Button variant="eink" aria-pressed={scene === 'Movie'} onClick={() => applyScene('Movie')}><Film />Movie mode</Button><Button variant="eink" onClick={() => { setScene(''); demo('movie mode ended'); }}><ArrowLeft />End movie</Button></div>
        {['Yamaha R-N500', 'Sony TV'].map((name, index) => <section className="media-device" key={name}><div className="media-title">{index === 0 ? <Music2 size={27} /> : <Tv size={27} />}<div><strong>{name}</strong><p>Unavailable</p></div><Button variant="eink" disabled aria-label={`Power ${name}`}><Power /></Button></div>
          <div className="transport">{[{ icon: SkipBack, label: 'Previous' }, { icon: Play, label: 'Play' }, { icon: Pause, label: 'Pause' }, { icon: SkipForward, label: 'Next' }].map(({ icon: Icon, label }) => <Button variant="eink" disabled key={label} title={label} aria-label={`${label} on ${name}`}><Icon /></Button>)}</div>
          <div className="source-control"><span>Source</span><span>—</span></div><div className="source-control"><span><Volume2 size={16} /> Volume</span><div className="level-control"><Button variant="eink" disabled aria-label={`Lower volume on ${name}`}><Minus /></Button><span className="level-value">—</span><Button variant="eink" disabled aria-label={`Raise volume on ${name}`}><Plus /></Button></div></div>
        </section>)}
      </>}
    </main>
    <footer className="screen-footer"><span className="footer-mark"><Check size={13} /><span role="status">{notice}</span></span><span>{tabs.findIndex(item => item.name === tab) + 1} / 4</span></footer>
  </div></div>;
}