<template>
  <div class="flex gap-4 h-full">
    <!-- Sidebar -->
    <div class="w-48 shrink-0 space-y-2 overflow-y-auto glass p-4 flex flex-col">
      <!-- Database Selector -->
      <div class="space-y-2">
        <button
          v-for="db in databases"
          :key="db"
          @click="selectedDb = db"
          :class="[
            'w-full text-left px-4 py-3 rounded-lg font-medium transition',
            selectedDb === db
              ? 'bg-amber-500/20 border border-amber-500 text-primary'
              : 'text-secondary hover:text-primary'
          ]"
        >
          {{ db }}
        </button>
      </div>

      <!-- MongoDB Collections -->
      <div v-if="selectedDb === 'MongoDB'" class="border-t border-gray-200 dark:border-gray-700 pt-4 flex-1 overflow-y-auto">
        <div class="text-xs font-semibold text-gray-500 mb-2">Collections</div>
        <button
          v-for="col in mongoCollections"
          :key="col"
          @click="selectMongoCollection(col, 'normal')"
          @click.shift="selectMongoCollection(col, 'shift')"
          @click.ctrl="selectMongoCollection(col, 'ctrl')"
          @contextmenu.prevent
          :class="[
            'w-full text-left px-3 py-2 rounded text-sm transition',
            activeCollection === col
              ? 'row-active'
              : 'text-secondary hover:text-primary row-hover'
          ]"
          :title="`Click: select | Shift+Click: new tab | Ctrl+Click: replace`"
        >
          {{ col }}
        </button>
      </div>

      <!-- Firestore nav. The COLLECTION list is the fixed top level — it never changes.
           A collection click opens a tab AND loads its children below (no chevron; the
           click does both, exactly like before). Drilling happens on the children, beneath
           the unchanged collection: a sub-path breadcrumb (click = up one) + that level's
           children. Documents need the › chevron to drill (their click opens a tab);
           subcollections drill on click like collections. Levels are paged. -->
      <div v-if="selectedDb === 'Firestore'" class="border-t border-gray-200 dark:border-gray-700 pt-4 flex-1 min-h-0 overflow-y-auto">
        <div class="text-xs font-semibold text-gray-500 mb-2">Collections</div>
        <template v-for="col in fsCollections" :key="col.path">
          <!-- Collection: fixed, click = open tab + load children. No chevron. -->
          <button
            @click="fsSelectCollection(col)"
            :class="[
              'w-full text-left px-3 py-2 rounded text-sm transition truncate',
              fsCollection && fsCollection.path === col.path ? 'row-active' : 'text-secondary hover:text-primary row-hover'
            ]"
          >{{ col.id }}</button>

          <!-- Children of the SELECTED collection, nested directly beneath it — collapses
               when another collection is selected. No dividers, no extra header lines. -->
          <div v-if="fsCollection && fsCollection.path === col.path" class="mb-1">
            <!-- Sub-path breadcrumb within the collection; click = up one level. Stays pinned. -->
            <button
              v-if="fsTrail.length"
              @click="fsUp"
              :title="fsSubPath"
              class="block w-full text-left text-sm font-semibold text-primary underline decoration-dotted underline-offset-2 truncate my-1"
            >‹ {{ fsSubPath }}</button>

            <!-- At most ~4 rows visible; the rest scroll. -->
            <div class="max-h-[150px] overflow-y-auto space-y-0.5">
            <div
              v-for="child in fsChildren"
              :key="child.path"
              class="flex items-center rounded row-hover"
              :class="fsIsActive(child) ? 'row-active' : ''"
            >
              <button
                @click="fsOpen(child)"
                :disabled="child.type === 'document' && !child.hasFields && !child.hasChildren"
                :title="child.type === 'document' && !child.hasFields ? (child.hasChildren ? `${child.id} — subcollections only (open to browse)` : `${child.id} — empty (no fields or subcollections)`) : child.id"
                :class="[
                  'flex-1 min-w-0 text-left px-3 py-2 rounded text-sm truncate',
                  child.type === 'document' && !child.hasFields && !child.hasChildren
                    ? 'text-muted italic opacity-50 cursor-default'
                    : 'text-secondary hover:text-primary'
                ]"
              >{{ child.id }}</button>
              <!-- Chevron only for DOCUMENTS (their click opens a tab → drilling needs its own
                   control). Subcollections drill on click, like collections — no chevron. -->
              <button
                v-if="child.type === 'document' && child.hasChildren"
                @click="fsDrill(child)"
                class="px-2 py-2 text-muted hover:text-primary shrink-0"
                title="Open children"
              >›</button>
            </div>

            <div v-if="!fsChildren.length && !fsLoading" class="text-xs text-muted px-3 py-2">{{ fsLevelEmpty }}</div>
            <button
              v-if="fsHasMore"
              @click="fsLoadMore"
              :disabled="fsLoading"
              class="w-full text-xs text-secondary hover:text-primary py-2 disabled:opacity-50"
            >Load more · {{ fsChildren.length }}/{{ fsTotal }}</button>
            <div v-if="fsLoading" class="text-xs text-muted px-3 py-2">Loading…</div>
            </div>
          </div>
        </template>
        <div v-if="!fsCollections.length" class="text-xs text-muted px-3 py-2">No collections</div>
      </div>
    </div>

    <!-- Content Area -->
    <div class="flex-1 min-w-0 flex flex-col min-h-0 p-4 gap-4 glass">
      <!-- MongoDB: Full Compass Explorer -->
      <div v-if="selectedDb === 'MongoDB'" class="flex flex-col h-full min-h-0">
        <!-- Collection Tabs -->
        <div v-if="openMongoCollections.length > 0" class="w-full border-b border-gray-200 dark:border-gray-700 flex gap-2 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-800">
          <div
            v-for="tab in openMongoCollections"
            :key="tab.id"
            :class="[
              'flex items-center px-3 py-2 text-sm font-medium rounded-t border-b-2 transition whitespace-nowrap flex-shrink-0',
              activeTabId === tab.id
                ? 'surface-2 border-amber-500 text-primary'
                : 'border-transparent text-muted hover:text-primary'
            ]"
          >
            <button
              @click="selectMongoCollection(tab.collection, 'normal'); activeTabId = tab.id"
              class="mr-1 hover:opacity-80 transition"
              :title="`${tab.collection}`"
            >
              {{ tab.collection }}
            </button>
            <button
              v-if="openMongoCollections.length > 1"
              @click="openMongoCollections = openMongoCollections.filter(t => t.id !== tab.id); if (activeTabId === tab.id && openMongoCollections.length > 0) { activeTabId = openMongoCollections[0].id; mongoCollection = openMongoCollections[0].collection; queryMongo() }"
              class="text-xs px-1 hover:text-red-400 transition flex-shrink-0"
              title="Close tab"
            >
              ✕
            </button>
          </div>
        </div>

        <!-- Documents/Indexes Tabs -->
        <div class="px-4 flex gap-8">
          <button
            @click="mongoTab = 'documents'"
            :class="[
              'px-1 py-3 text-sm font-medium border-b-2 transition-all duration-200',
              mongoTab === 'documents'
                ? 'text-strong border-amber-500'
                : 'text-secondary hover:text-primary border-transparent'
            ]"
          >
            Documents
            <span v-if="mongoResults.length" class="ml-2 text-xs">{{ mongoResults.length }}</span>
          </button>
          <button
            @click="mongoTab = 'indexes'"
            :class="[
              'px-1 py-3 text-sm font-medium transition border-b-2',
              mongoTab === 'indexes'
                ? 'text-strong border-green-500'
                : 'text-secondary hover:text-primary border-transparent'
            ]"
          >
            Indexes
          </button>
        </div>

        <!-- Documents Tab -->
        <div v-show="mongoTab === 'documents'" class="flex flex-col h-full min-h-0">
          <!-- Query Bar -->
          <div class="px-4 py-3 surface-2">
            <div class="flex items-center gap-3">
              <div class="flex-1 relative">
                <input
                  v-model="mongoFilter"
                  type="text"
                  placeholder="Type a query: { field: 'value' }"
                  @keyup.enter="queryMongo"
                  @input="validateMongoFilter"
                  :class="[
                    'w-full form-input text-sm font-mono transition border-2',
                    mongoFilterValid === true ? 'border-green-500/30' : mongoFilterValid === false ? 'border-red-500/50' : 'border-transparent'
                  ]"
                />
                <div v-if="mongoFilterError" class="absolute top-full left-0 mt-1 text-xs text-red-400 font-mono bg-red-950/40 px-2 py-1 rounded pointer-events-none">
                  {{ mongoFilterError }}
                </div>
              </div>
              <button class="px-4 py-1.5 btn-muted text-sm rounded transition">
                Explain
              </button>
              <button @click="mongoFilter = '{}'; validateMongoFilter()" class="px-4 py-1.5 btn-muted text-sm rounded transition">
                Reset
              </button>
              <button
                @click="queryMongo"
                :disabled="loadingMongo || mongoFilterValid === false"
                class="px-4 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold text-sm rounded transition"
              >
                Find
              </button>
              <button
                @click="showMongoOptions = !showMongoOptions"
                class="px-3 py-1.5 text-blue-400 hover:text-blue-300 text-sm transition"
              >
                Options {{ showMongoOptions ? '▲' : '▼' }}
              </button>
            </div>
          </div>

          <!-- Query Options (Collapsible) -->
          <div v-if="showMongoOptions" class="px-4 py-4 surface-2-soft space-y-4">
            <!-- Row 1: Project, Sort -->
            <div class="grid grid-cols-2 gap-6">
              <div>
                <label class="text-xs text-secondary font-semibold block mb-2">Project</label>
                <div class="relative">
                  <input
                    v-model="mongoProjection"
                    type="text"
                    placeholder='{ field: 0 }'
                    @input="validateMongoProjection"
                    :class="[
                      'w-full form-input text-xs font-mono transition border-2',
                      mongoProjectionValid === true ? 'border-green-500/30' : mongoProjectionValid === false ? 'border-red-500/50' : 'border-transparent'
                    ]"
                  />
                  <div v-if="mongoProjectionError" class="absolute top-full left-0 mt-1 text-xs text-red-400 font-mono bg-red-950/40 px-1 py-0.5 rounded">{{ mongoProjectionError }}</div>
                </div>
              </div>
              <div>
                <label class="text-xs text-secondary font-semibold block mb-2">Sort</label>
                <div class="relative">
                  <input
                    v-model="mongoSort"
                    type="text"
                    placeholder='{ field: -1 }'
                    @input="validateMongoSort"
                    :class="[
                      'w-full form-input text-xs font-mono transition border-2',
                      mongoSortValid === true ? 'border-green-500/30' : mongoSortValid === false ? 'border-red-500/50' : 'border-transparent'
                    ]"
                  />
                  <div v-if="mongoSortError" class="absolute top-full left-0 mt-1 text-xs text-red-400 font-mono bg-red-950/40 px-1 py-0.5 rounded">{{ mongoSortError }}</div>
                </div>
              </div>
            </div>

            <!-- Row 2: Collation, Index Hint -->
            <div class="grid grid-cols-2 gap-6">
              <div>
                <label class="text-xs text-secondary font-semibold block mb-2">Collation</label>
                <div class="relative">
                  <input
                    v-model="mongoCollation"
                    type="text"
                    placeholder="{ locale: 'simple' }"
                    @input="validateMongoCollation"
                    :class="[
                      'w-full form-input text-xs font-mono transition border-2',
                      mongoCollationValid === true ? 'border-green-500/30' : mongoCollationValid === false ? 'border-red-500/50' : 'border-transparent'
                    ]"
                  />
                  <div v-if="mongoCollationError" class="absolute top-full left-0 mt-1 text-xs text-red-400 font-mono bg-red-950/40 px-1 py-0.5 rounded">{{ mongoCollationError }}</div>
                </div>
              </div>
              <div>
                <label class="text-xs text-secondary font-semibold block mb-2">Index Hint</label>
                <div class="relative">
                  <input
                    v-model="mongoIndexHint"
                    type="text"
                    placeholder='{ field: -1 }'
                    @input="validateMongoIndexHint"
                    :class="[
                      'w-full form-input text-xs font-mono transition border-2',
                      mongoIndexHintValid === true ? 'border-green-500/30' : mongoIndexHintValid === false ? 'border-red-500/50' : 'border-transparent'
                    ]"
                  />
                  <div v-if="mongoIndexHintError" class="absolute top-full left-0 mt-1 text-xs text-red-400 font-mono bg-red-950/40 px-1 py-0.5 rounded">{{ mongoIndexHintError }}</div>
                </div>
              </div>
            </div>

            <!-- Row 3: Max Time MS (right aligned) -->
            <div class="grid grid-cols-2 gap-6">
              <div></div>
              <div>
                <label class="text-xs text-secondary font-semibold block mb-2">Max Time MS</label>
                <input v-model.number="mongoMaxTime" type="number" placeholder="60000" class="w-full form-input text-xs" />
              </div>
            </div>

            <!-- Row 4: Skip, Limit -->
            <div class="grid grid-cols-2 gap-6">
              <div>
                <label class="text-xs text-secondary font-semibold block mb-2">Skip</label>
                <input v-model.number="mongoSkip" type="number" placeholder="0" class="w-full form-input text-xs" />
              </div>
              <div>
                <label class="text-xs text-secondary font-semibold block mb-2">Limit</label>
                <input v-model.number="mongoLimit" type="number" placeholder="0" class="w-full form-input text-xs" />
              </div>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="px-4 py-3 flex items-center gap-3">
            <div class="relative">
              <button
                @click="showExportMenu = !showExportMenu"
                class="px-3 py-1.5 btn-muted text-xs font-semibold rounded transition"
              >
                EXPORT DATA
              </button>
              <div v-if="showExportMenu" class="absolute top-full left-0 mt-1 surface-overlay rounded z-10 flex flex-col min-w-max">
                <button class="text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700 transition">
                  Export query results
                </button>
                <button class="text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700 transition">
                  Export the full collection
                </button>
              </div>
            </div>
            <button class="px-3 py-1.5 btn-muted text-xs font-semibold rounded transition">
              EXPORT CODE
            </button>
            <div class="flex-1"></div>
            <div class="relative">
              <button
                @click="showPageSizeMenu = !showPageSizeMenu"
                class="px-2 py-1 surface-2 border border-gray-200 dark:border-white/10 rounded text-xs text-secondary hover:bg-gray-100 dark:hover:bg-gray-100 dark:hover:bg-gray-700 transition"
              >
                {{ mongoLimit }}
              </button>
              <div
                v-if="showPageSizeMenu"
                class="absolute top-full right-0 mt-1 surface-overlay rounded z-50 flex flex-col min-w-max"
              >
                <button
                  v-for="size in [25, 50, 75, 100]"
                  :key="size"
                  @click="mongoLimit = size; showPageSizeMenu = false"
                  :class="[
                    'text-left px-3 py-2 text-xs transition',
                    mongoLimit === size
                      ? 'bg-gray-200 dark:bg-gray-700 text-primary'
                      : 'text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700'
                  ]"
                >
                  {{ size }}
                </button>
              </div>
            </div>
            <div class="text-xs text-secondary">
              {{ mongoResults.length > 0 ? `1 - ${Math.min(mongoCurrentDoc + mongoLimit, mongoResults.length)} of ${mongoResults.length}` : '0' }}
            </div>
            <button
              @click="queryMongo"
              :disabled="loadingMongo || mongoResults.length === 0"
              class="px-2 py-1 text-secondary hover:text-primary"
              title="Refresh"
            >
              ↻
            </button>
            <button @click="mongoCurrentDoc = Math.max(0, mongoCurrentDoc - mongoLimit)" :disabled="mongoCurrentDoc === 0" class="px-2 py-1 text-secondary hover:text-primary disabled:opacity-50">◀</button>
            <button @click="mongoCurrentDoc = Math.min(mongoResults.length - mongoLimit, mongoCurrentDoc + mongoLimit)" :disabled="mongoCurrentDoc + mongoLimit >= mongoResults.length" class="px-2 py-1 text-secondary hover:text-primary disabled:opacity-50">▶</button>
            <div class="relative">
              <button
                @click="showMongoExpandMenu = !showMongoExpandMenu"
                class="px-2 py-1 text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition"
                title="Expand/collapse"
              >
                ▼
              </button>
              <div
                v-if="showMongoExpandMenu"
                class="absolute top-full left-0 mt-1 surface-overlay rounded z-50 flex flex-col min-w-max"
              >
                <button
                  @click="expandAllDocs"
                  class="w-full text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                >
                  Expand all documents
                </button>
                <button
                  @click="collapseAllDocs"
                  class="w-full text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                >
                  Collapse all documents
                </button>
              </div>
            </div>
            <button
              @click="mongoViewType = 'list'"
              :class="[
                'px-2 py-1 rounded transition',
                mongoViewType === 'list'
                  ? 'bg-gray-200 dark:bg-gray-700 text-primary'
                  : 'text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700'
              ]"
              title="List view"
            >
              ≡
            </button>
            <button
              @click="mongoViewType = 'json'"
              :class="[
                'px-2 py-1 rounded transition',
                mongoViewType === 'json'
                  ? 'bg-gray-200 dark:bg-gray-700 text-primary'
                  : 'text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700'
              ]"
              title="JSON view"
            >
              {}
            </button>
            <button
              @click="mongoViewType = 'grid'"
              :class="[
                'px-2 py-1 rounded transition',
                mongoViewType === 'grid'
                  ? 'bg-gray-200 dark:bg-gray-700 text-primary'
                  : 'text-secondary hover:text-primary hover:bg-gray-100 dark:hover:bg-gray-700'
              ]"
              title="Grid view"
            >
              ⊞
            </button>
          </div>

          <!-- Documents -->
          <div v-if="mongoResults.length > 0" class="flex-1 overflow-auto min-h-0">
            <!-- List View (default) -->
            <div v-if="mongoViewType === 'list'" class="divide-y divide-gray-200 dark:divide-white/5">
              <div
                v-for="doc in mongoResults.slice(mongoCurrentDoc, mongoCurrentDoc + mongoLimit)"
                :key="doc._id"
                class="border-l-4 border-l-transparent hover:!border-l-amber-500 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition duration-500"
              >
                <div class="p-4 cursor-pointer" @click="toggleDocExpanded(doc._id)">
                  <div class="flex items-center gap-2 text-xs text-amber-400 font-mono">
                    <span>{{ expandedDocs.has(doc._id) ? '▼' : '▶' }}</span>
                    <span>{{ doc._id }}</span>
                  </div>
                </div>
                <div v-if="expandedDocs.has(doc._id)" class="px-4 pb-4">
                  <pre class="text-xs code-block font-mono overflow-x-auto whitespace-pre-wrap break-words p-3 rounded">{{ JSON.stringify(doc, null, 2) }}</pre>
                </div>
              </div>
            </div>

            <!-- JSON View -->
            <div v-else-if="mongoViewType === 'json'" class="p-4">
              <pre class="text-xs text-secondary font-mono overflow-x-auto">{{ JSON.stringify(mongoResults.slice(mongoCurrentDoc, mongoCurrentDoc + mongoLimit), null, 2) }}</pre>
            </div>

            <!-- Grid View -->
            <div v-else-if="mongoViewType === 'grid'" class="p-4 grid grid-cols-2 gap-3">
              <div
                v-for="doc in mongoResults.slice(mongoCurrentDoc, mongoCurrentDoc + mongoLimit)"
                :key="doc._id"
                class="p-3 surface-2 border border-gray-200 dark:border-white/10 rounded-lg hover:border-amber-500 transition"
              >
                <pre class="text-xs text-secondary font-mono overflow-x-auto whitespace-pre-wrap break-words">{{ JSON.stringify(doc, null, 2).slice(0, 200) }}...</pre>
              </div>
            </div>
          </div>

          <!-- Error/Empty -->
          <div v-if="mongoError" class="flex-1 flex items-center justify-center">
            <div class="text-xs text-error font-mono">{{ mongoError }}</div>
          </div>
          <div v-if="!loadingMongo && !mongoError && mongoResults.length === 0" class="flex-1 flex items-center justify-center text-muted">
            <div class="text-xs">Run a query to see documents</div>
          </div>
        </div>
<!-- Indexes Tab -->
        <div v-show="mongoTab === 'indexes'" class="flex-1 flex flex-col min-h-0">
            <!-- Index View Selector -->
            <div class="px-4 py-3 flex items-center gap-2">
              <div class="flex-1"></div>
              <button
                @click="mongoIndexView = 'indexes'; queryMongoIndexes()"
                :class="[
                  'px-4 py-1.5 text-xs font-semibold rounded transition',
                  mongoIndexView === 'indexes'
                    ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                    : 'btn-muted'
                ]"
              >
                INDEXES
              </button>
              <button
                @click="mongoIndexView = 'search-indexes'"
                :class="[
                  'px-4 py-1.5 text-xs font-semibold rounded transition',
                  mongoIndexView === 'search-indexes'
                    ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                    : 'btn-muted'
                ]"
              >
                SEARCH INDEXES
              </button>
            </div>

            <!-- Content Area -->
            <div class="flex-1 overflow-auto min-h-0">
              <!-- Loading State -->
              <div v-if="loadingMongoIndexes" class="flex items-center justify-center h-full">
                <div class="text-xs text-secondary">Fetching indexes...</div>
              </div>

              <!-- Error State -->
              <div v-else-if="mongoIndexError" class="flex items-center justify-center h-full">
                <div class="text-xs text-error text-center font-mono max-w-96">{{ mongoIndexError }}</div>
              </div>

              <!-- Regular Indexes Table -->
              <table v-else-if="mongoIndexView === 'indexes'" class="w-full text-xs">
                <thead class="sticky top-0 surface-2 border-b border-gray-200 dark:border-white/10">
                  <tr>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Name &amp; Definition</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Type</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Size</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Usage</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Properties</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-200 dark:divide-white/5">
                  <tr v-if="mongoIndexes.length === 0" class="hover:bg-gray-100 dark:hover:bg-gray-800/50">
                    <td colspan="6" class="px-4 py-4 text-center text-muted">No indexes</td>
                  </tr>
                  <tr v-for="idx in mongoIndexes" :key="idx.name" class="hover:bg-gray-100 dark:hover:bg-gray-800/50">
                    <td class="px-4 py-3 font-mono text-amber-400">{{ idx.name }}</td>
                    <td class="px-4 py-3">
                      <span class="px-2 py-1 tag-muted rounded text-xs">{{ idx.type }}</span>
                    </td>
                    <td class="px-4 py-3">{{ idx.size }}</td>
                    <td class="px-4 py-3 text-muted">{{ idx.usage }}</td>
                    <td class="px-4 py-3">
                      <div class="flex gap-1 flex-wrap">
                        <span v-if="idx.unique" class="px-2 py-1 tag-muted rounded text-xs">UNIQUE</span>
                        <span v-if="idx.compound" class="px-2 py-1 tag-muted rounded text-xs">COMPOUND</span>
                      </div>
                    </td>
                    <td class="px-4 py-3">
                      <span class="px-2 py-1 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 rounded text-xs">{{ idx.status }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>

              <!-- Search Indexes Placeholder -->
              <div v-else-if="mongoIndexView === 'search-indexes'" class="flex items-center justify-center h-full">
                <div class="text-xs text-muted">Search indexes coming soon</div>
              </div>
            </div>
          </div>

      </div>

      <!-- Firestore: Firebase Console-like Browser -->
      <div v-if="selectedDb === 'Firestore'" class="flex flex-col h-full min-h-0">
        <!-- Collection Tabs (mirrors Mongo) -->
        <div v-if="openFirestoreCollections.length > 0" class="w-full border-b border-gray-200 dark:border-gray-700 flex gap-2 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-800">
          <div
            v-for="tab in openFirestoreCollections"
            :key="tab.id"
            :class="[
              'flex items-center px-3 py-2 text-sm font-medium rounded-t border-b-2 transition whitespace-nowrap flex-shrink-0',
              activeFirestoreTabId === tab.id
                ? 'surface-2 border-amber-500 text-primary'
                : 'border-transparent text-muted hover:text-primary'
            ]"
          >
            <button @click="activateFirestoreTab(tab)" class="mr-1 hover:opacity-80 transition" :title="tab.collection + (tab.docId ? '/' + tab.docId : '')">
              {{ tab.label || tab.collection }}
            </button>
            <button
              v-if="openFirestoreCollections.length > 1"
              @click="closeFirestoreTab(tab)"
              class="text-xs px-1 hover:text-red-400 transition flex-shrink-0"
              title="Close tab"
            >✕</button>
          </div>
        </div>

        <!-- Data/Rules/Indexes Tabs + (Data-only) controls pushed to the far right -->
        <div class="px-4 flex items-center gap-8">
          <button
            @click="firestoreTab = 'data'"
            :class="[
              'px-1 py-3 text-sm font-medium border-b-2 transition-all duration-200',
              firestoreTab === 'data' ? 'text-strong border-amber-500' : 'text-secondary hover:text-primary border-transparent'
            ]"
          >
            Data
          </button>
          <button
            @click="firestoreTab = 'rules'"
            :class="[
              'px-1 py-3 text-sm font-medium transition border-b-2',
              firestoreTab === 'rules' ? 'text-strong border-amber-500' : 'text-secondary hover:text-primary border-transparent'
            ]"
          >
            Rules
          </button>
          <button
            @click="firestoreTab = 'indexes'"
            :class="[
              'px-1 py-3 text-sm font-medium transition border-b-2',
              firestoreTab === 'indexes' ? 'text-strong border-amber-500' : 'text-secondary hover:text-primary border-transparent'
            ]"
          >
            Indexes
          </button>

          <!-- Data controls, far right of the tab bar -->
          <div v-if="firestoreTab === 'data'" class="ml-auto flex items-center gap-3">
            <button
              @click="showFirestoreSubcollections = !showFirestoreSubcollections"
              :class="['px-2 py-1 text-xs rounded transition', showFirestoreSubcollections ? 'bg-amber-500/20 text-amber-400' : 'text-secondary hover:text-primary']"
              title="Show/hide subcollections when you expand a document"
            >
              {{ showFirestoreSubcollections ? 'Subcollections ✓' : 'Subcollections' }}
            </button>
            <span class="text-xs text-secondary">{{ firestoreResults.length }} documents</span>
            <button
              @click="queryFirestore"
              :disabled="loadingFirestore || firestoreResults.length === 0"
              class="px-2 py-1 text-secondary hover:text-primary"
              title="Refresh"
            >↻</button>
          </div>
        </div>

        <!-- Data Tab -->
        <div v-show="firestoreTab === 'data'" class="flex-1 flex flex-col min-h-0">
          <!-- Documents — recursive tree; expand a doc to drill into its subcollections -->
          <div v-if="firestoreResults.length > 0 || firestoreDocSubcols.length > 0" class="flex-1 overflow-auto min-h-0">
            <!-- Field-less doc: render its CONTENTS (subcollection groups) directly, no self node. -->
            <div v-for="sub in firestoreDocSubcols" :key="sub.name">
              <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-amber-400/70 font-semibold">{{ sub.name }} ({{ sub.docs.length }})</div>
              <FirestoreNode
                v-for="child in sub.docs"
                :key="child.path"
                :doc="child"
                :level="0"
                :show-subcollections="showFirestoreSubcollections"
              />
            </div>
            <!-- Collection docs / a doc with fields. -->
            <FirestoreNode
              v-for="doc in firestoreResults"
              :key="doc.id"
              :doc="doc"
              :level="0"
              :show-subcollections="showFirestoreSubcollections"
            />
          </div>

          <!-- Error -->
          <div v-if="firestoreError" class="flex-1 flex items-center justify-center">
            <div class="text-xs text-error font-mono text-center">{{ firestoreError }}</div>
          </div>

          <!-- Empty -->
          <div v-if="!loadingFirestore && !firestoreError && firestoreResults.length === 0 && firestoreDocSubcols.length === 0" class="flex-1 flex items-center justify-center text-muted">
            <div class="text-xs text-center">No documents found</div>
          </div>
        </div>

        <!-- Rules Tab — live active ruleset (Firebase Rules API) -->
        <div v-show="firestoreTab === 'rules'" class="flex-1 flex flex-col min-h-0">
          <div class="px-4 py-3 flex items-center gap-2">
            <div class="flex-1 text-xs text-secondary font-mono truncate">{{ firestoreRulesName }}</div>
            <button @click="loadFirestoreRules" :disabled="loadingFirestoreRules" class="px-2 py-1 text-secondary hover:text-primary" title="Refresh">↻</button>
          </div>
          <div v-if="firestoreRulesError" class="flex-1 flex items-center justify-center">
            <div class="text-xs text-error font-mono text-center">{{ firestoreRulesError }}</div>
          </div>
          <div v-else class="flex-1 overflow-auto min-h-0 px-4 pb-4">
            <pre class="text-xs code-block font-mono whitespace-pre-wrap break-words p-3 rounded">{{ loadingFirestoreRules ? 'Loading…' : (firestoreRules || 'No rules') }}</pre>
          </div>
        </div>

        <!-- Indexes Tab — live composite indexes (Firestore Admin API) -->
        <div v-show="firestoreTab === 'indexes'" class="flex-1 flex flex-col min-h-0">
          <div class="px-4 py-3 flex items-center gap-2">
            <div class="flex-1"></div>
            <div class="text-xs text-secondary">{{ firestoreIndexes.length }} {{ firestoreIndexes.length === 1 ? 'index' : 'indexes' }}</div>
            <button @click="loadFirestoreIndexes" :disabled="loadingFirestoreIndexes" class="px-2 py-1 text-secondary hover:text-primary" title="Refresh">↻</button>
          </div>
          <div v-if="firestoreIndexesError" class="flex-1 flex items-center justify-center">
            <div class="text-xs text-error font-mono text-center">{{ firestoreIndexesError }}</div>
          </div>
          <div v-else-if="firestoreIndexes.length" class="flex-1 overflow-auto min-h-0">
            <div class="divide-y divide-gray-200 dark:divide-white/5">
              <div
                v-for="idx in firestoreIndexes"
                :key="idx.name"
                class="p-4 border-l-4 border-l-transparent hover:!border-l-amber-500 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition duration-500"
              >
                <div class="flex items-baseline gap-2">
                  <span class="text-sm text-amber-400 font-mono">{{ indexCollection(idx) }}</span>
                  <span class="text-[10px] uppercase tracking-wide text-secondary">{{ scopeLabel(idx.queryScope) }}</span>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2 text-sm font-mono">
                  <span
                    v-for="(f, i) in idx.fields"
                    :key="i"
                    :title="`${f.fieldPath} — ${f.order || f.arrayConfig}`"
                    :class="[
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-100 dark:bg-white/5 leading-none',
                      f.fieldPath === '__name__' ? 'opacity-40' : ''
                    ]"
                  >
                    <span class="text-strong leading-none">{{ f.fieldPath }}</span>
                    <span class="text-amber-400 text-base leading-none">{{ fieldDir(f) }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="flex-1 flex items-center justify-center text-muted">
            <div class="text-xs">{{ loadingFirestoreIndexes ? 'Loading…' : 'No composite indexes' }}</div>
          </div>
        </div>

      </div>

      <!-- Neo4j: GraphQL Explorer (schema introspection + visualizer + query) -->
      <div v-if="selectedDb === 'Neo4j'" class="flex flex-col gap-4 h-full">
        <div class="panel p-4 space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs text-secondary font-semibold">Neo4j GraphQL</div>
            <div class="text-xs text-muted">{{ neo4jHost }}</div>
          </div>
          <div class="flex gap-2">
            <button
              @click="loadGraphqlSchema"
              :disabled="loadingGraphql"
              class="flex-1 px-3 py-2 text-xs font-medium rounded-lg btn-muted disabled:opacity-50 hover:text-primary transition"
            >
              {{ introspection ? 'Schema Loaded' : 'Load Schema' }}
            </button>
            <button
              @click="showVisualizer = !showVisualizer"
              class="flex-1 px-3 py-2 text-xs font-medium rounded-lg btn-muted hover:text-primary transition"
            >
              {{ showVisualizer ? 'Hide Graph' : 'View Graph' }}
            </button>
            <button
              @click="executeGraphql"
              :disabled="loadingGraphql || !graphqlQuery"
              class="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-gray-900 font-bold rounded-lg transition"
            >
              {{ loadingGraphql ? '...' : 'Run Query' }}
            </button>
          </div>
          <div v-if="graphqlQueryHistory.length > 0" class="flex items-center gap-2">
            <select
              @change="(e) => { graphqlQuery = e.target.value; e.target.value = '' }"
              class="flex-1 px-3 py-1.5 btn-muted border border-gray-200 dark:border-white/10 rounded text-xs hover:text-primary transition"
            >
              <option value="">← History (last {{ graphqlQueryHistory.length }})</option>
              <option v-for="(query, idx) in graphqlQueryHistory" :key="idx" :value="query">
                {{ query.slice(0, 60) }}{{ query.length > 60 ? '...' : '' }}
              </option>
            </select>
            <button
              @click="graphqlQueryHistory = []; localStorage.removeItem('graphql-history')"
              class="px-2 py-1.5 text-xs text-muted hover:text-red-400 transition"
            >
              Clear
            </button>
          </div>
        </div>

        <!-- Data graph explorer (Neo4j Workspace Explore-style) -->
        <div v-if="showVisualizer" class="flex-1 min-h-0">
          <GraphExplorer :env="storeEnv" />
        </div>

        <!-- Query Editor + Results -->
        <div v-show="!showVisualizer" class="flex gap-4 flex-1 min-h-0">
          <div class="flex-1 panel p-4 space-y-3 flex flex-col min-h-0">
            <label class="text-xs text-secondary font-semibold">Query</label>
            <textarea
              v-model="graphqlQuery"
              placeholder="query {&#10;  users {&#10;    id&#10;    name&#10;  }&#10;}"
              class="flex-1 form-input text-sm font-mono resize-none"
            />
            <div class="text-xs text-muted">
              {{ introspection ? 'Schema available' : 'Load schema first' }}
            </div>
          </div>

          <div class="flex-1 flex flex-col gap-3 min-h-0">
            <div v-if="graphqlError" class="panel p-4 bg-red-500/10 border-red-500/30 rounded-lg">
              <div class="text-xs text-error font-mono overflow-auto max-h-24">{{ graphqlError }}</div>
            </div>

            <div v-if="graphqlData" class="panel p-4 flex-1 overflow-auto min-h-0">
              <div class="text-xs text-secondary font-semibold mb-3">Result</div>
              <pre class="text-xs text-secondary font-mono whitespace-pre-wrap break-words">{{ JSON.stringify(graphqlData, null, 2) }}</pre>
            </div>

            <div v-else-if="!loadingGraphql && graphqlQuery" class="panel p-4 flex-1 flex items-center justify-center text-muted">
              <div class="text-xs text-center">Ready to execute</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getIntrospectionQuery } from 'graphql'
import { VNetworkGraph } from 'v-network-graph'
import 'v-network-graph/lib/style.css'

const databases = ['MongoDB', 'Firestore', 'Neo4j']
const selectedDb = ref('MongoDB')

// MongoDB
const mongoCollection = ref('results')
const mongoCollections = ref([])
const openMongoCollections = ref([])  // Array of { id: string, collection: string }
const activeTabId = ref(null)  // Track which tab is currently active
const tabIdCounter = ref(0)
// The collection of the ACTIVE tab — drives sidebar highlight (only the
// active collection lights up, not every open tab).
const activeCollection = computed(() => {
  const tab = openMongoCollections.value.find(t => t.id === activeTabId.value)
  return tab ? tab.collection : null
})
const mongoFilter = ref('{}')
const mongoFilterValid = ref(true)
const mongoFilterError = ref('')
const mongoProjection = ref('{}')
const mongoProjectionValid = ref(true)
const mongoProjectionError = ref('')
const mongoSort = ref('')
const mongoSortValid = ref(true)
const mongoSortError = ref('')
const mongoCollation = ref('')
const mongoCollationValid = ref(true)
const mongoCollationError = ref('')
const mongoIndexHint = ref('')
const mongoIndexHintValid = ref(true)
const mongoIndexHintError = ref('')
const mongoMaxTime = ref(60000)
const mongoSkip = ref(0)
const mongoLimit = ref(25)
const mongoResults = ref([])
const mongoError = ref('')
const loadingMongo = ref(false)
const selectedMongoDoc = ref(null)
const mongoTab = ref('documents')
const mongoCurrentDoc = ref(0)
const showMongoOptions = ref(false)
const mongoIndexes = ref([])
const loadingMongoIndexes = ref(false)
const mongoIndexError = ref('')
const mongoIndexView = ref('indexes')  // 'indexes' or 'search-indexes'
const showExportMenu = ref(false)
const showPageSizeMenu = ref(false)
const showMongoExpandMenu = ref(false)
const expandedDocs = ref(new Set())
const mongoViewType = ref('list')
const mongoColumns = computed(() => {
  if (mongoResults.value.length === 0) return []
  const keys = new Set()
  mongoResults.value.slice(0, 10).forEach(doc => {
    Object.keys(doc).forEach(k => {
      if (k !== '_id') keys.add(k)
    })
  })
  return Array.from(keys).slice(0, 8)
})

// Firestore
const firestoreCollection = ref('Results')  // active node path (collection or subcollection)
const openFirestoreCollections = ref([])    // open tabs: [{ id, collection (path), label, docId }]
const activeFirestoreTabId = ref('')
const showFirestoreSubcollections = ref(true)  // Data-panel filter: drill into subcollections on expand

// Rules + Indexes are admin-side (not client) — fetched live from GCP via our server.
const firestoreIndexes = ref([])
const loadingFirestoreIndexes = ref(false)
const firestoreIndexesError = ref('')
let firestoreIndexesLoaded = false
const firestoreRules = ref('')
const firestoreRulesName = ref('')
const loadingFirestoreRules = ref(false)
const firestoreRulesError = ref('')
let firestoreRulesLoaded = false

const indexCollection = (idx) => idx.name?.split('/collectionGroups/')[1]?.split('/indexes/')[0] || '?'
const scopeLabel = (s) => (s === 'COLLECTION_GROUP' ? 'collection group' : 'collection')
const fieldDir = (f) => (f.arrayConfig ? '(array)' : f.order === 'DESCENDING' ? '↓' : '↑')

const loadFirestoreIndexes = async () => {
  loadingFirestoreIndexes.value = true
  firestoreIndexesError.value = ''
  try {
    firestoreIndexes.value = await $fetch('/api/store/firestore-indexes')
    firestoreIndexesLoaded = true
  } catch (err) {
    firestoreIndexesError.value = err?.data?.statusMessage || err.message || 'Failed to load indexes'
  } finally {
    loadingFirestoreIndexes.value = false
  }
}

const loadFirestoreRules = async () => {
  loadingFirestoreRules.value = true
  firestoreRulesError.value = ''
  try {
    const res = await $fetch('/api/store/firestore-rules')
    firestoreRules.value = res.source || ''
    firestoreRulesName.value = res.rulesetName || ''
    firestoreRulesLoaded = true
  } catch (err) {
    firestoreRulesError.value = err?.data?.statusMessage || err.message || 'Failed to load rules'
  } finally {
    loadingFirestoreRules.value = false
  }
}
const firestoreDocId = ref('')
const firestoreResults = ref([])
const firestoreDocSubcols = ref([])   // a field-less doc's contents: its subcollections, shown at root
const firestoreError = ref('')
const loadingFirestore = ref(false)
const firestoreTab = ref('data')
// Fetch the tab's data the first time it's opened (project-level, so once is enough).
watch(firestoreTab, (t) => {
  if (t === 'indexes' && !firestoreIndexesLoaded) loadFirestoreIndexes()
  if (t === 'rules' && !firestoreRulesLoaded) loadFirestoreRules()
})
const firestoreColumns = computed(() => {
  if (firestoreResults.value.length === 0) return []
  const keys = new Set()
  firestoreResults.value.slice(0, 10).forEach(doc => {
    if (doc.data) Object.keys(doc.data).forEach(k => keys.add(k))
  })
  return Array.from(keys).slice(0, 8)
})

// GraphQL — endpoint comes from the two settings (local | production), toggle-driven.
const { env: storeEnv } = useEnvironment()
const rtConfig = useRuntimeConfig()
const graphqlEndpoint = computed(() =>
  storeEnv.value === 'production'
    ? (rtConfig.public.graphqlEndpointProd || rtConfig.public.graphqlEndpoint)
    : rtConfig.public.graphqlEndpoint
)
// Neo4j GraphQL runs server-side via @neo4j/graphql over the Bolt driver (the app's connection).
const neo4jHost = computed(() => (graphqlEndpoint.value || '').replace(/^https?:\/\//, '').replace(/\/graphql\/?$/, '').replace(/\/$/, ''))
const graphqlQuery = ref('')
const graphqlQueryHistory = ref([])
const graphqlData = ref(null)
const graphqlError = ref('')
const loadingGraphql = ref(false)
const showVisualizer = ref(false)
const introspection = ref(null)
const graphNodes = ref({})
const graphEdges = ref({})
const graphConfig = ref({
  node: {
    label: { visible: true, fontSize: 11, lineHeight: 1.4 },
    radius: 24,
    fill: '#1f2937',
    stroke: '#f5a623',
    strokeWidth: 2,
  },
  edge: {
    stroke: '#f5a62350',
    strokeWidth: 2,
    arrow: { middle: { enabled: false }, end: { enabled: true, type: 'arrow' } },
    normal: { width: 1 },
    hover: { width: 3 },
    selected: { width: 3, stroke: '#f5a623' },
  },
  view: {
    padding: 40,
    minZoom: 0.2,
    maxZoom: 4,
    doubleClickZoomEnabled: true,
  },
})

const validateJSON = (str, fieldRef, errorRef) => {
  if (!str || !str.trim()) {
    fieldRef.value = null
    errorRef.value = ''
    return true
  }
  try {
    JSON.parse(str)
    errorRef.value = ''
    fieldRef.value = true
    return true
  } catch (e) {
    errorRef.value = e.message.replace('JSON.parse: ', '')
    fieldRef.value = false
    return false
  }
}

const validateMongoFilter = () => validateJSON(mongoFilter.value, mongoFilterValid, mongoFilterError)
const validateMongoProjection = () => validateJSON(mongoProjection.value, mongoProjectionValid, mongoProjectionError)
const validateMongoSort = () => validateJSON(mongoSort.value, mongoSortValid, mongoSortError)
const validateMongoCollation = () => validateJSON(mongoCollation.value, mongoCollationValid, mongoCollationError)
const validateMongoIndexHint = () => validateJSON(mongoIndexHint.value, mongoIndexHintValid, mongoIndexHintError)

const docValue = (doc, field) => {
  if (!doc) return '-'
  const val = doc[field]
  if (val === null || val === undefined) return '-'
  if (typeof val === 'boolean') return val ? 'true' : 'false'
  if (typeof val === 'object') {
    const str = JSON.stringify(val)
    return str.length > 30 ? str.slice(0, 27) + '…' : str
  }
  const str = String(val)
  return str.length > 30 ? str.slice(0, 27) + '…' : str
}

const loadMongoCollections = async () => {
  try {
    const res = await $fetch('/api/store/mongo-collections')
    mongoCollections.value = res || []
    if (mongoCollections.value.length > 0) {
      // Auto-select first collection with unique tab ID
      mongoCollection.value = mongoCollections.value[0]
      const tabId = `tab-${tabIdCounter.value++}`
      activeTabId.value = tabId
      openMongoCollections.value = [{ id: tabId, collection: mongoCollections.value[0] }]
      mongoFilter.value = '{}'
      await queryMongo()
    }
  } catch (err) {
    console.error('Failed to load collections:', err)
    mongoCollections.value = []
  }
}

// ---- Firestore sidebar nav -----------------------------------------------------
// The COLLECTION list (fsCollections) is the FIXED top level — it never changes.
// fsCollection = the active root collection; fsTrail = the nodes drilled BELOW it
// (docs/subcollections). The current node = the deepest of [collection, ...trail], and
// its children fill the level under the collection. Collections/subcollections drill on
// click (+ open a tab, like before); documents open a tab on click and drill via the ›.
const FS_PAGE = 25
const fsCollections = ref([])   // root collections — the fixed top list
const fsCollection = ref(null)  // active root collection { id, type:'collection', path } | null
const fsTrail = ref([])         // drilled nodes below the collection [{ id, type, path }]
const fsChildren = ref([])      // children of the current node (paged)
const fsOffset = ref(0)
const fsTotal = ref(0)
const fsHasMore = ref(false)
const fsLoading = ref(false)

const fsNode = computed(() => (fsTrail.value.length ? fsTrail.value[fsTrail.value.length - 1] : fsCollection.value))
const fsSubPath = computed(() => fsTrail.value.map((n) => n.id).join(' → '))
const fsLevelEmpty = computed(() => (fsNode.value?.type === 'document' ? 'No subcollections' : 'No documents'))

// Root collections — loaded once when Firestore opens; this list is the fixed top level.
const fsLoadRoots = async () => {
  try {
    const res = await $fetch('/api/store/firestore-children', { method: 'POST', body: { type: 'root', limit: 200 } })
    fsCollections.value = res.children || []
    if (fsCollections.value.length && !fsCollection.value) fsSelectCollection(fsCollections.value[0])
  } catch (err) {
    console.error('Failed to load Firestore collections:', err)
    fsCollections.value = []
  }
}

const fsLoad = async (reset = true) => {
  const node = fsNode.value
  if (!node) { fsChildren.value = []; return }
  if (reset) { fsOffset.value = 0; fsChildren.value = [] }
  fsLoading.value = true
  try {
    const res = await $fetch('/api/store/firestore-children', {
      method: 'POST',
      body: { type: node.type, path: node.path, offset: fsOffset.value, limit: FS_PAGE },
    })
    fsChildren.value = reset ? res.children : [...fsChildren.value, ...res.children]
    fsTotal.value = res.total
    fsHasMore.value = res.hasMore
    fsOffset.value = fsChildren.value.length
  } catch (err) {
    console.error('Failed to load Firestore children:', err)
  } finally {
    fsLoading.value = false
  }
}
const fsLoadMore = () => fsLoad(false)

// Click a root collection: open its tab + load its docs below (resets the drill). No chevron.
const fsSelectCollection = (col) => {
  fsCollection.value = { id: col.id, type: 'collection', path: col.path }
  fsTrail.value = []
  openFirestorePathTab(col.path, col.id)
  fsLoad(true)
}
// Drill into a child node (push onto the trail, load its children).
const fsDrill = (child) => {
  fsTrail.value = [...fsTrail.value, { id: child.id, type: child.type, path: child.path }]
  if (child.type === 'collection') openFirestorePathTab(child.path, child.id) // subcollection: also open its tab
  fsLoad(true)
}
// Breadcrumb click → up ONE level (pop the last drilled node).
const fsUp = () => { fsTrail.value = fsTrail.value.slice(0, -1); fsLoad(true) }

// Name click: a subcollection drills (+ tab); a document opens its tab only if it has fields.
const fsOpen = (child) => {
  if (child.type === 'collection') fsDrill(child)
  // A doc opens a tab if it has fields OR subcollections — a field-less parent shows its children
  // (the doc node auto-expands). Only a truly empty doc (neither) is inert.
  else if (child.type === 'document' && (child.hasFields || child.hasChildren)) openFirestoreDocTab(child)
}
// Highlight the sidebar row whose tab is active.
const fsIsActive = (child) => {
  const t = openFirestoreCollections.value.find((x) => x.id === activeFirestoreTabId.value)
  if (!t) return false
  return child.type === 'document' ? `${t.collection}/${t.docId}` === child.path : t.collection === child.path && !t.docId
}

// A collection/subcollection tab: Data panel lists its docs (db.collection(path) accepts
// the full slash path, so subcollections work the same as roots).
const openFirestorePathTab = (path, label) => {
  const existing = openFirestoreCollections.value.find((t) => t.collection === path && !t.docId)
  if (existing) { activeFirestoreTabId.value = existing.id }
  else {
    const id = `tab-${tabIdCounter.value++}`
    openFirestoreCollections.value.push({ id, collection: path, label: label || path, docId: null })
    activeFirestoreTabId.value = id
  }
  firestoreCollection.value = path
  firestoreDocId.value = ''
  queryFirestore()
}
// A single-document tab (the doc has fields): Data panel shows that one doc.
const openFirestoreDocTab = (child) => {
  const parent = child.path.slice(0, child.path.lastIndexOf('/'))
  const existing = openFirestoreCollections.value.find((t) => t.collection === parent && t.docId === child.id)
  if (existing) { activeFirestoreTabId.value = existing.id }
  else {
    const id = `tab-${tabIdCounter.value++}`
    openFirestoreCollections.value.push({ id, collection: parent, label: child.id, docId: child.id })
    activeFirestoreTabId.value = id
  }
  firestoreCollection.value = parent
  firestoreDocId.value = child.id
  queryFirestore()
}

const activateFirestoreTab = (tab) => {
  activeFirestoreTabId.value = tab.id
  firestoreCollection.value = tab.collection
  firestoreDocId.value = tab.docId || ''
  queryFirestore()
}

const closeFirestoreTab = (tab) => {
  openFirestoreCollections.value = openFirestoreCollections.value.filter((t) => t.id !== tab.id)
  if (activeFirestoreTabId.value === tab.id && openFirestoreCollections.value.length > 0) {
    activateFirestoreTab(openFirestoreCollections.value[0])
  }
}

const selectMongoCollection = (collection, modifier = 'normal') => {
  let activeId = null

  if (modifier === 'ctrl') {
    // Ctrl+Click: replace current tabs - only have this collection open
    const tabId = `tab-${tabIdCounter.value++}`
    openMongoCollections.value = [{ id: tabId, collection }]
    activeId = tabId
  } else if (modifier === 'shift') {
    // Shift+Click: always add new tab even if collection already exists elsewhere
    // This allows viewing same collection in multiple tabs
    const tabId = `tab-${tabIdCounter.value++}`
    openMongoCollections.value.push({ id: tabId, collection })
    activeId = tabId
  } else {
    // Normal click: select if exists, add if not
    const existingTab = openMongoCollections.value.find(tab => tab.collection === collection)
    if (existingTab) {
      activeId = existingTab.id
    } else {
      const tabId = `tab-${tabIdCounter.value++}`
      openMongoCollections.value.push({ id: tabId, collection })
      activeId = tabId
    }
  }

  activeTabId.value = activeId
  mongoCollection.value = collection
  mongoFilter.value = '{}'
  validateMongoFilter()
  queryMongo()
}

// Monotonic stamp so out-of-order / superseded responses can't paint the wrong
// collection's docs under the active tab (the "showing both collections" bug).
let mongoQuerySeq = 0

const queryMongo = async () => {
  if (!mongoCollection.value) return
  const seq = ++mongoQuerySeq
  const queriedCollection = mongoCollection.value
  loadingMongo.value = true
  mongoError.value = ''
  mongoResults.value = []
  selectedMongoDoc.value = null
  mongoCurrentDoc.value = 0

  try {
    let filter = {}
    let projection = {}

    try {
      filter = mongoFilter.value.trim() ? JSON.parse(mongoFilter.value) : {}
    } catch (e) {
      throw new Error(`Invalid filter JSON: ${e.message}`)
    }

    try {
      projection = mongoProjection.value.trim() ? JSON.parse(mongoProjection.value) : {}
    } catch (e) {
      throw new Error(`Invalid projection JSON: ${e.message}`)
    }

    const res = await $fetch('/api/store/mongo', {
      method: 'POST',
      body: {
        collection: queriedCollection,
        query: filter,
        projection,
        limit: mongoLimit.value
      }
    })
    // Drop this response if a newer query has since been issued.
    if (seq !== mongoQuerySeq) return
    mongoResults.value = Array.isArray(res) ? res : [res]
  } catch (err) {
    if (seq !== mongoQuerySeq) return
    mongoError.value = err.message || 'Query failed'
  } finally {
    if (seq === mongoQuerySeq) loadingMongo.value = false
  }
}

const queryMongoIndexes = async () => {
  if (!mongoCollection.value) return
  loadingMongoIndexes.value = true
  mongoIndexError.value = ''
  mongoIndexes.value = []

  try {
    const res = await $fetch('/api/store/mongo-indexes', {
      method: 'POST',
      body: {
        collection: mongoCollection.value
      }
    })
    mongoIndexes.value = Array.isArray(res) ? res : []
  } catch (err) {
    mongoIndexError.value = err.message || 'Failed to load indexes'
  } finally {
    loadingMongoIndexes.value = false
  }
}

const expandAllDocs = () => {
  mongoResults.value.forEach((doc) => {
    expandedDocs.value.add(doc._id)
  })
  showMongoExpandMenu.value = false
}

const collapseAllDocs = () => {
  expandedDocs.value.clear()
  showMongoExpandMenu.value = false
}

const toggleDocExpanded = (docId) => {
  if (expandedDocs.value.has(docId)) {
    expandedDocs.value.delete(docId)
  } else {
    expandedDocs.value.add(docId)
  }
}

watch(() => mongoTab.value, (newTab) => {
  if (newTab === 'indexes') {
    queryMongoIndexes()
  }
})

watch(() => mongoLimit.value, () => {
  mongoCurrentDoc.value = 0
})

watch(() => mongoResults.value, () => {
  expandedDocs.value.clear()
  showMongoExpandMenu.value = false
})

const queryFirestore = async () => {
  if (!firestoreCollection.value) return
  loadingFirestore.value = true
  firestoreError.value = ''
  firestoreResults.value = []
  firestoreDocSubcols.value = []

  try {
    const res = await $fetch('/api/store/firestore', {
      method: 'POST',
      body: {
        collection: firestoreCollection.value,
        docId: firestoreDocId.value || null
      }
    })

    if (firestoreDocId.value) {
      const hasFields = res.exists && res.data && Object.keys(res.data).length > 0
      if (hasFields) {
        firestoreResults.value = [{ id: res.id, path: res.path, data: res.data }]
      } else {
        // Field-less doc: you're IN it, so show its CONTENTS (subcollections), not a self-named
        // node. Right query = the `path` (subcollections) branch, not the doc query.
        const sub = await $fetch('/api/store/firestore', { method: 'POST', body: { path: res.path || `${firestoreCollection.value}/${firestoreDocId.value}` } })
        firestoreDocSubcols.value = sub.subcollections || []
      }
    } else {
      firestoreResults.value = Array.isArray(res) ? res : Object.entries(res).map(([id, data]) => ({ id, data }))
    }
  } catch (err) {
    firestoreError.value = err.message || 'Query failed'
  } finally {
    loadingFirestore.value = false
  }
}

const buildSchemaGraph = (introspectionData) => {
  const nodes = {}
  const edges = {}
  const typeMap = new Map()
  let nodeIdx = 0

  if (!introspectionData || !introspectionData.__schema) return

  const types = introspectionData.__schema.types || []
  const filtered = types.filter(t => !t.name.startsWith('__') && t.kind !== 'SCALAR' && t.kind !== 'ENUM')

  filtered.forEach((type) => {
    const angle = (nodeIdx / filtered.length) * Math.PI * 2
    const radius = 250 + (Math.random() - 0.5) * 100
    nodes[type.name] = {
      label: type.name,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    }
    typeMap.set(type.name, type)
    nodeIdx++
  })

  let edgeIdx = 0
  const seenEdges = new Set()

  typeMap.forEach((type) => {
    if (!type.fields) return
    type.fields.forEach((field) => {
      let fieldType = field.type
      while (fieldType.ofType) fieldType = fieldType.ofType
      const typeName = fieldType.name

      if (typeName && nodes[typeName] && typeName !== type.name) {
        const edgeKey = [type.name, typeName].sort().join('-')
        if (!seenEdges.has(edgeKey)) {
          edges[`edge-${edgeIdx}`] = {
            source: type.name,
            target: typeName,
          }
          seenEdges.add(edgeKey)
          edgeIdx++
        }
      }
    })
  })

  graphNodes.value = nodes
  graphEdges.value = edges
}

// All GraphQL goes through our server proxy (/api/store/graphql) — the browser can't reach the
// Aura endpoint directly (CORS) and creds stay server-side. `env` picks local vs prod upstream.
const loadGraphqlSchema = async () => {
  loadingGraphql.value = true
  graphqlError.value = ''

  try {
    const res = await $fetch('/api/store/graphql', {
      method: 'POST',
      body: { query: getIntrospectionQuery(), env: storeEnv.value }
    })

    if (res.errors) {
      graphqlError.value = res.errors.map(e => e.message).join('\n')
    } else if (res.data) {
      introspection.value = res.data
      buildSchemaGraph(res.data)
    }
  } catch (err) {
    graphqlError.value = err?.data?.statusMessage || err.message || 'Failed to load schema'
  } finally {
    loadingGraphql.value = false
  }
}

const executeGraphql = async () => {
  if (!graphqlQuery.value) return
  loadingGraphql.value = true
  graphqlError.value = ''
  graphqlData.value = null

  try {
    const res = await $fetch('/api/store/graphql', {
      method: 'POST',
      body: { query: graphqlQuery.value, env: storeEnv.value }
    })

    if (res.errors) {
      graphqlError.value = res.errors.map(e => e.message).join('\n')
    } else {
      graphqlData.value = res.data
      // Add to history
      if (!graphqlQueryHistory.value.includes(graphqlQuery.value)) {
        graphqlQueryHistory.value.unshift(graphqlQuery.value)
        if (graphqlQueryHistory.value.length > 20) {
          graphqlQueryHistory.value.pop()
        }
        localStorage.setItem('graphql-history', JSON.stringify(graphqlQueryHistory.value))
      }
    }
  } catch (err) {
    graphqlError.value = err?.data?.statusMessage || err.message || 'Query failed'
  } finally {
    loadingGraphql.value = false
  }
}

// Load GraphQL history from localStorage
if (process.client) {
  const saved = localStorage.getItem('graphql-history')
  if (saved) {
    try {
      graphqlQueryHistory.value = JSON.parse(saved)
    } catch (e) {
      // Invalid JSON, skip
    }
  }
}

// Load a DB's collection list when it's selected (Firestore lazily; Mongo on mount below).
watch(selectedDb, (db) => {
  if (db === 'Firestore' && fsCollections.value.length === 0) fsLoadRoots()
})

// Load MongoDB collections on mount
onMounted(() => {
  loadMongoCollections()
})
</script>

