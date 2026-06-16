<!-- Editor for one step_definition. Matches the Prompt form: scrollable body + footer pinned at the
     bottom, full width. Order is set by drag-drop in the list. instruction/pass/fail are ALL Handlebars
     templates rendered server-side at submit; the help opens BESIDE the whole template block (Instruction
     + Pass + Fail) so you can read it while editing any of the three. -->
<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex-1 overflow-y-auto overflow-x-clip min-h-0 px-1">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-serif text-primary">{{ step.id ? 'Edit step' : 'New step' }}</h2>
        <div class="flex items-center gap-2">
          <span class="text-sm text-secondary">Active</span>
          <Toggle v-model="local.active" />
        </div>
      </div>

      <!-- Compact 4-col grid: Name spans the row; Subtype/Kind sit left of the Model group, which
           spans BOTH rows on the right (Default over production-only Override); Run once fills the
           left half of the second row. -->
      <div class="grid grid-cols-4 gap-4 mb-4">
        <div class="col-span-4">
          <label class="block text-sm text-secondary mb-1">Name</label>
          <input v-model="local.name" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" class="form-input w-full" placeholder="name" />
        </div>
        <div>
          <label class="block text-sm text-secondary mb-1">Subtype</label>
          <Select v-model="local.subtype" :options="subtypeOptions" placeholder="subtype" />
        </div>
        <div>
          <label class="block text-sm text-secondary mb-1">Kind</label>
          <Select v-model="local.kind" :options="kindOptions" />
        </div>
        <div class="col-span-2 row-span-2">
          <label class="block text-sm text-secondary mb-1 cursor-help" title="The model that runs THIS step. Defined per step — there is no run-level model on the plan form.">Model</label>
          <div class="space-y-3">
            <div>
              <span class="block text-xs text-muted mb-1 cursor-help" title="Default — the model that runs this step. Dev and dry-runs always use this.">Default</span>
              <Select v-model="local.model" :options="modelOptions" placeholder="— select a model —" />
            </div>
            <div>
              <span class="block text-xs text-muted mb-1 cursor-help" title="Production override — in production only, run this step on a different model (e.g. a larger GPU tier). Dev and dry-runs ignore this. Leave as “same as Model” for no override.">Override</span>
              <Select v-model="local.modelProd" :options="prodModelOptions" placeholder="— same as Model (no override) —" />
            </div>
          </div>
        </div>
        <div>
          <label class="block text-sm text-secondary mb-1 cursor-help" title="What this step fans out over: a list field (e.g. legals) → once per entry; 'days' → once per day; a number → that many; blank → one run. Reference the current one as {{item}} — or name it: 'Legals as |legal|' → use {{legal}}.">Run once per</label>
          <input v-model="local.mapOf" :disabled="local.kind === 'chain'" :placeholder="local.kind === 'chain' ? 'inherited from the chained step' : ''" class="form-input w-full disabled:opacity-50 disabled:cursor-not-allowed" />
        </div>
        <div>
          <label class="block text-sm text-secondary mb-1 cursor-help" title="What kind of output this step produces. Structured = a strict format like YAML or a checklist (most consistent, least improvising); Blended = a structured shape with some written prose; Unstructured = free-form or conversational. Stricter = more consistent and repeatable.">Style</label>
          <Select v-model="local.style" :options="styleOptions" />
        </div>
      </div>

      <!-- Chip fields + the output toggle, four across. -->
      <div class="grid grid-cols-4 gap-4 mb-4">
        <div>
          <label class="block text-sm text-secondary mb-1 cursor-help" :title="local.kind === 'chain' ? 'A chain step rides exactly ONE earlier step\'s fan-out 1:1; pick that source step.' : 'Results from these earlier steps are passed in as context. If all of them get skipped, this step is dropped too.'">Earlier Steps{{ local.kind === 'chain' ? ' (the chained step)' : '' }}</label>
          <ChipInput v-model="local.context" :options="stepOptions" :max="local.kind === 'chain' ? 1 : 0" placeholder="earlier steps…" />
        </div>
        <div>
          <label class="block text-sm text-secondary mb-1 cursor-help" title="Form fields this step uses. The chip fields (Institution, Legals, Diets, Restrictions) also GATE it — the step is skipped if a required chip is empty or off. Always-present fields (residents, days, costTier, date, region…) are just made available to the template.">Required Inputs</label>
          <ChipInput v-model="local.inputs" :options="inputOptions" placeholder="add…" />
        </div>
        <div>
          <label class="block text-sm text-secondary mb-1 cursor-help" title="Only include this step for menus that have these options switched on.">Options Filter</label>
          <ChipInput v-model="local.requiredFlags" :options="flagOptions" placeholder="options…" />
        </div>
        <div>
          <label class="block text-sm text-secondary mb-1 cursor-help" title="When on, this step's output is part of the final result the user sees.">Include Step Results</label>
          <div class="flex items-center h-9"><Toggle v-model="local.includeInOutput" /></div>
        </div>
      </div>

      <div class="mb-4">
        <label class="block text-sm text-secondary mb-1 cursor-help" title="Tools the model may call during this step.">Tools</label>
        <ChipInput v-model="local.tools" :options="toolOptions" placeholder="add…" />
      </div>

      <!-- Template block — Instruction + Pass + Fail are all Handlebars, so ONE help panel sits beside
           the whole block (left column) and spans all three. It's sticky so it stays readable while you
           scroll between the fields. -->
      <div class="flex gap-4 mb-4 items-stretch">
        <!-- left column: every Handlebars-templated field -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between mb-1">
            <label class="block text-sm text-secondary cursor-help" title="Handlebars template — rendered with this step's values at submit.">Instruction</label>
            <div class="flex items-center gap-3">
              <button type="button" title="Ask Remy to draft the instruction (coming soon)" class="grid place-items-center w-6 h-6 rounded-full text-muted hover:text-amber-400 hover:bg-amber-400/10 active:scale-90 transition" @click="askRemy('instruction')">
                <SparklesIcon class="w-4 h-4" />
              </button>
              <button type="button" class="text-xs text-amber-400 hover:text-amber-300 transition" @click="showHelp = !showHelp">{{ showHelp ? 'Hide help' : 'Handlebars help' }}</button>
            </div>
          </div>
          <textarea v-model="local.instruction" rows="10" class="form-input w-full font-mono text-sm" :placeholder="hint.instruction"></textarea>

          <div class="grid grid-cols-2 gap-4 mt-5">
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-sm text-secondary cursor-help" title="Handlebars template — what a passing result looks like.">Pass</label>
                <button type="button" title="Ask Remy to draft the pass criteria (coming soon)" class="grid place-items-center w-6 h-6 rounded-full text-muted hover:text-amber-400 hover:bg-amber-400/10 active:scale-90 transition" @click="askRemy('pass criteria')">
                  <SparklesIcon class="w-4 h-4" />
                </button>
              </div>
              <textarea v-model="local.pass" rows="3" class="form-input w-full font-mono text-sm" :placeholder="hint.pass"></textarea>
            </div>
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-sm text-secondary cursor-help" title="Handlebars template — what a failing result looks like.">Fail</label>
                <button type="button" title="Ask Remy to draft the fail criteria (coming soon)" class="grid place-items-center w-6 h-6 rounded-full text-muted hover:text-amber-400 hover:bg-amber-400/10 active:scale-90 transition" @click="askRemy('fail criteria')">
                  <SparklesIcon class="w-4 h-4" />
                </button>
              </div>
              <textarea v-model="local.fail" rows="3" class="form-input w-full font-mono text-sm" :placeholder="hint.fail"></textarea>
            </div>
          </div>

          <!-- Routing — directly under Pass/Fail, aligned to match: On success sits below Pass (left),
               On failure below Fail (right). -->
          <div class="grid grid-cols-2 gap-4 mt-5">
            <div>
              <label class="block text-sm text-muted mb-1 cursor-help" title="Not supported yet — advancement is linear (the next step). This will let a step branch to a non-adjacent step on success.">On success → go to</label>
              <Select v-model="local.successStep" :options="successStepOptions" :disabled="true" placeholder="— next step (linear) —" />
            </div>
            <div>
              <label class="block text-sm text-secondary mb-1 cursor-help" title="If this step fails its check, the plan reverts here and re-runs from this step forward. Leave as default to just re-run THIS step. A review/compliance step defaults to reverting to the step it validates.">On failure → go to</label>
              <Select v-model="local.failStep" :options="failStepOptions" placeholder="default — re-run this step" />
            </div>
          </div>
        </div>

        <!-- shared help — spans the whole template block; sticky so it follows you between fields -->
        <div v-show="showHelp" class="w-80 shrink-0 self-start sticky top-0 rounded-lg surface-overlay border border-divider p-3 text-xs text-secondary overflow-auto" style="max-height: calc(100vh - 10rem)">
          <div v-pre class="space-y-2">
            <p class="text-muted">Used for Instruction, Pass, and Fail — all rendered with Handlebars against this step's values. Field names are case-insensitive ({{Legals}} = {{legals}}).</p>
            <div>
              <div class="font-medium text-secondary mb-1">Basics</div>
              <ul class="space-y-0.5 font-mono">
                <li>{{residents}} — insert a value</li>
                <li>{{join diets ", "}} — join a list → "a, b, c"</li>
                <li>{{count diets}} — how many in a list (min 1)</li>
                <li>{{#each diets}}- {{this}} {{/each}} — loop a list</li>
                <li>{{#if flags.pureed}}…{{/if}} / {{#unless legals}}…{{/unless}}</li>
              </ul>
            </div>
            <div>
              <div class="font-medium text-secondary mb-1">Compare — eq ne gt lt ge le</div>
              <ul class="space-y-0.5 font-mono">
                <li>{{#eq (count institution) 1}}facility{{else}}facilities{{/eq}}</li>
                <li>{{#if (gt (count diets) 5)}}…{{/if}} — same, as a test</li>
                <li>list vs a number → compares the list's length</li>
              </ul>
            </div>
            <div>
              <div class="font-medium text-secondary mb-1">Run once per (fan-out)</div>
              <ul class="space-y-0.5 font-mono">
                <li>legals — one unit per legal; refer to it as {{legal}}</li>
                <li>Legals as |legal| — name the unit yourself → {{legal}}</li>
                <li>{{item}} {{itemIndex}} {{itemCount}} — current item + position</li>
                <li>{{#each (zip legals codes) as |pair|}}{{pair.[0]}}→{{pair.[1]}}{{/each}} — pair lists</li>
              </ul>
            </div>
            <div>
              <div class="font-medium text-secondary mb-1">Seasons & dates (needs a Location)</div>
              <ul class="space-y-0.5 font-mono">
                <li>{{date}} today · {{tomorrow}} the next day</li>
                <li>{{date itemIndex}} — this unit's date (skips weekends if "weekdays only")</li>
                <li>{{season}} — current season; {{season (date itemIndex)}} — season for that day</li>
                <li>{{seasons}} — the 4 seasons, rotated to start at the current one</li>
                <li>{{seasonDate "winter"}} — that season's start date</li>
                <li>{{weekday (date itemIndex)}} — day name, e.g. {{#eq (weekday (date itemIndex)) "Friday"}}…{{/eq}}</li>
              </ul>
            </div>
            <div>
              <div class="font-medium text-secondary mb-1">Diet breakdown & portions (math done in code)</div>
              <ul class="space-y-0.5 font-mono">
                <li>{{#each (allocate diets residents) as |d|}}{{d.diet}}: {{d.count}}
{{/each}} — split residents across the diet mix</li>
                <li>per row: .pct (% of residents) · .demand (share, rounded up) · .count (batch + 5% buffer)</li>
                <li>{{allocate diets residents 0.1}} — override the buffer (here 10%)</li>
              </ul>
            </div>
            <div>
              <div class="font-medium text-secondary mb-1">Variables</div>
              <ul class="space-y-0.5 font-mono">
                <li>{{residents}} {{days}} {{weeks}} — numbers</li>
                <li>{{diets}} {{legals}} {{restrictions}} {{institution}} {{meals}} — lists</li>
                <li>{{dietsRaw}} {{legalsRaw}} … — same, as strings</li>
                <li>{{value}} / {{valueList}} — this step's own input</li>
                <li>{{costTier}} — the cost tier</li>
                <li>{{flags.pureed}} {{flags.business_days}} — options</li>
                <li>{{date}} {{time}} {{region}} {{hemisphere}} {{tz}} — when Location is set</li>
                <li>{{jobId}} {{stepNumber}} {{batchIndex}} {{runId}} — runtime ids (filled in when the step runs)</li>
              </ul>
            </div>
            <div>
              <div class="font-medium text-secondary mb-1">Example</div>
              <pre class="whitespace-pre-wrap font-mono text-muted m-0">Build one day for {{residents}} honoring {{join diets ", "}}.{{#if flags.pureed}} Blendable only.{{/if}}{{#eq (count institution) 1}} For our facility.{{else}} For our facilities.{{/eq}}</pre>
            </div>
            <a class="text-amber-400 underline" href="https://handlebarsjs.com/guide/" target="_blank" rel="noopener">Handlebars guide ↗</a>
          </div>
        </div>
      </div>
    </div>

    <!-- fixed footer -->
    <div class="shrink-0 flex gap-2 pt-2">
      <button
        type="button"
        :disabled="!local.name || !local.model"
        :title="!local.name ? 'Name is required' : !local.model ? 'Pick a model' : ''"
        class="px-4 py-2 bg-amber-500 text-gray-900 rounded-lg font-medium hover:bg-amber-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
        @click="$emit('save', { ...local })"
      >Save</button>
      <button type="button" class="px-4 py-2 btn-muted rounded-lg transition" @click="$emit('cancel')">Cancel</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, watch, computed } from 'vue'
import { MENU_ENTRIES, MENU_FLAGS, STATIC_FIELDS } from '#menu-plan'
import { SUBTYPES, DEFAULT_TOOLS, MODELS } from '#models'
import { SparklesIcon } from '@heroicons/vue/24/outline'
import Select from '~/components/Select.vue'
import ChipInput from '~/components/ChipInput.vue'

const props = defineProps({ step: { type: Object, required: true }, stepOptions: { type: Array, default: () => [] } })
defineEmits(['save', 'cancel'])

const toast = useToast()
const showHelp = ref(false)
const askRemy = (what) => toast.success('Remy', `Remy will draft the ${what} — not wired up yet`)

const blank = {
  name: '', subtype: 'query', kind: 'fanout', mapOf: '', style: 'structured',
  active: true, includeInOutput: false, requiredFlags: [], inputs: [], context: [], tools: [],
  model: '', modelProd: '', failStep: '', successStep: '', instruction: '', pass: '', fail: '',
}
const local = reactive({ ...blank, ...props.step })
watch(() => props.step, (s) => Object.assign(local, blank, s))

const subtypeOptions = SUBTYPES.map((s) => ({ value: s.name, label: s.name }))
const kindOptions = ['fanout', 'chunks', 'aggregation', 'chain'].map((k) => ({ value: k, label: k }))
// Output style → the worker maps it to a generation temperature (config/models.js STYLE_TEMPS,
// DB-overridable in model_config `_styles`). structured is the safe default for the structured pipeline.
const styleOptions = ['structured', 'blended', 'unstructured'].map((s) => ({ value: s, label: s }))
// The model that runs this step (value = topic, what the dispatcher routes on). The model is defined
// HERE, on the step — there's no run-level model, so it's REQUIRED (gates Save). No empty option; an
// unset model shows the placeholder. Same registry (#models).
const modelOptions = MODELS.map((m) => ({ value: m.topic, label: m.label }))
// Production model is an OPTIONAL prod-only override of the Model above; the empty entry clears it.
const prodModelOptions = [{ value: '', label: '— same as Model (no override) —' }, ...modelOptions]
const flagOptions = MENU_FLAGS.map((f) => f.key)
// Required Inputs offers the actual FORM FIELDS (STATIC_FIELDS) — no derived/duplicate values. The chip
// fields (institution/legals/diets/restrictions) also GATE the step (skipped if empty/off); the rest
// (residents, costTier, flags) are always present, so selecting them is just "this step uses it".
// Derived vars (days, date, season, region…) aren't here — they're in the Handlebars help panel.
const CHIP_LABELS = Object.fromEntries(MENU_ENTRIES.filter((e) => e.group === 'input').map((e) => [e.key, e.label]))
const inputOptions = STATIC_FIELDS.map((f) => ({ value: f, label: CHIP_LABELS[f] || f }))
// Real, implemented tools (config/models.js DEFAULT_TOOLS) — value is the tool name the worker keys
// on, label is the underscores-as-spaces human form.
const toolOptions = DEFAULT_TOOLS.map((t) => ({ value: t.name, label: t.name.replace(/_/g, ' ') }))
// "On failure → go to" picks an earlier step (or the default = re-run this step). Same step list as
// Earlier Steps, with a leading default entry; the server resolves the chosen NAME to its plan index.
const failStepOptions = computed(() => [{ value: '', label: '— re-run this step (default) —' }, ...props.stepOptions])
// successStep is not supported yet (advancement is linear) — its own empty label so the disabled
// field doesn't borrow the failure field's "re-run this step" wording.
const successStepOptions = computed(() => [{ value: '', label: '— next step (linear) —' }, ...props.stepOptions])

// Greyed placeholder examples — show the common helpers so authors see what's possible.
const hint = {
  instruction: 'Plan day {{itemIndex}} ({{date itemIndex}}) for {{residents}} honoring {{join diets ", "}}.\nUse only produce in season for {{season (date itemIndex)}}.{{#if flags.pureed}} Blendable — no bones.{{/if}}',
  pass: 'A full day of meals — every item in season and within the listed diets.',
  fail: 'Out-of-season produce, a missing meal, or a diet not honored.',
}
</script>
