/* Tweaks panel — density + card style */
const { useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "cozy",
  "cards": "flat"
}/*EDITMODE-END*/;

function NutritionTweaks() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Apply tweaks to <html data-*> so CSS vars cascade
  useEffect(() => {
    document.documentElement.dataset.density = t.density;
    document.documentElement.dataset.cards   = t.cards;
  }, [t.density, t.cards]);

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Densidad">
        <TweakRadio
          value={t.density}
          onChange={(v) => setTweak('density', v)}
          options={[
            { value: 'cozy',    label: 'Cómoda'   },
            { value: 'compact', label: 'Compacta' }
          ]}
        />
      </TweakSection>

      <TweakSection label="Estilo de tarjetas">
        <TweakRadio
          value={t.cards}
          onChange={(v) => setTweak('cards', v)}
          options={[
            { value: 'flat', label: 'Plano' },
            { value: 'soft', label: 'Suave' }
          ]}
        />
      </TweakSection>
    </TweaksPanel>
  );
}

ReactDOM.createRoot(
  (() => { const el = document.createElement('div'); document.body.appendChild(el); return el; })()
).render(<NutritionTweaks />);
