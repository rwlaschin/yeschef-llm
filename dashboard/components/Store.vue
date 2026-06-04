<template>
  <div class="flex gap-4 h-full">
    <!-- Sidebar -->
    <div class="w-48 space-y-2 overflow-y-auto glass p-4 flex flex-col">
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
      <div v-if="selectedDb === 'MongoDB'" class="border-t border-gray-700 pt-4 flex-1 overflow-y-auto">
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
            openMongoCollections.some(tab => tab.collection === col)
              ? 'bg-amber-500/20 text-primary border border-amber-500/50'
              : 'text-gray-300 hover:text-primary hover:bg-gray-800/50'
          ]"
          :title="`Click: select | Shift+Click: new tab | Ctrl+Click: replace`"
        >
          {{ col }}
        </button>
      </div>
    </div>

    <!-- Content Area -->
    <div class="flex-1 flex flex-col min-h-0 p-4 gap-4 glass">
      <!-- MongoDB: Full Compass Explorer -->
      <div v-if="selectedDb === 'MongoDB'" class="flex flex-col h-full min-h-0">
        <!-- Collection Tabs -->
        <div v-if="openMongoCollections.length > 0" class="w-full border-b border-gray-700 flex gap-2 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-gray-800">
          <div
            v-for="tab in openMongoCollections"
            :key="tab.id"
            :class="[
              'flex items-center px-3 py-2 text-sm font-medium rounded-t border-b-2 transition whitespace-nowrap flex-shrink-0',
              activeTabId === tab.id
                ? 'bg-gray-800/50 border-amber-500 text-primary'
                : 'border-transparent text-gray-400 hover:text-primary'
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
                ? 'text-white border-amber-500'
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
                ? 'text-white border-green-500'
                : 'text-secondary hover:text-primary border-transparent'
            ]"
          >
            Indexes
          </button>
        </div>

        <!-- Documents Tab -->
        <div v-show="mongoTab === 'documents'" class="flex flex-col h-full min-h-0">
          <!-- Query Bar -->
          <div class="px-4 py-3 bg-gray-800/40">
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
              <button class="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-secondary text-sm rounded transition">
                Explain
              </button>
              <button @click="mongoFilter = '{}'; validateMongoFilter()" class="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-secondary text-sm rounded transition">
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
          <div v-if="showMongoOptions" class="px-4 py-4 bg-gray-800/20 space-y-4">
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
                class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-secondary text-xs font-semibold rounded transition"
              >
                EXPORT DATA
              </button>
              <div v-if="showExportMenu" class="absolute top-full left-0 mt-1 bg-gray-800 border border-white/20 rounded shadow-lg z-10 flex flex-col min-w-max">
                <button class="text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-700 transition">
                  Export query results
                </button>
                <button class="text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-700 transition">
                  Export the full collection
                </button>
              </div>
            </div>
            <button class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-secondary text-xs font-semibold rounded transition">
              EXPORT CODE
            </button>
            <div class="flex-1"></div>
            <div class="relative">
              <button
                @click="showPageSizeMenu = !showPageSizeMenu"
                class="px-2 py-1 bg-gray-800 border border-white/10 rounded text-xs text-secondary hover:bg-gray-700 transition"
              >
                {{ mongoLimit }}
              </button>
              <div
                v-if="showPageSizeMenu"
                class="absolute top-full right-0 mt-1 bg-gray-800 border border-white/20 rounded shadow-lg z-50 flex flex-col min-w-max"
              >
                <button
                  v-for="size in [25, 50, 75, 100]"
                  :key="size"
                  @click="mongoLimit = size; showPageSizeMenu = false"
                  :class="[
                    'text-left px-3 py-2 text-xs transition',
                    mongoLimit === size
                      ? 'bg-gray-700 text-primary'
                      : 'text-secondary hover:text-primary hover:bg-gray-700'
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
                class="px-2 py-1 text-secondary hover:text-primary hover:bg-gray-700 rounded transition"
                title="Expand/collapse"
              >
                ▼
              </button>
              <div
                v-if="showMongoExpandMenu"
                class="absolute top-full left-0 mt-1 bg-gray-800 border border-white/20 rounded shadow-lg z-50 flex flex-col min-w-max"
              >
                <button
                  @click="expandAllDocs"
                  class="w-full text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-700 transition"
                >
                  Expand all documents
                </button>
                <button
                  @click="collapseAllDocs"
                  class="w-full text-left px-3 py-2 text-xs text-secondary hover:text-primary hover:bg-gray-700 transition"
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
                  ? 'bg-gray-700 text-primary'
                  : 'text-secondary hover:text-primary hover:bg-gray-700'
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
                  ? 'bg-gray-700 text-primary'
                  : 'text-secondary hover:text-primary hover:bg-gray-700'
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
                  ? 'bg-gray-700 text-primary'
                  : 'text-secondary hover:text-primary hover:bg-gray-700'
              ]"
              title="Grid view"
            >
              ⊞
            </button>
          </div>

          <!-- Documents -->
          <div v-if="mongoResults.length > 0" class="flex-1 overflow-auto min-h-0">
            <!-- List View (default) -->
            <div v-if="mongoViewType === 'list'" class="divide-y divide-white/5">
              <div
                v-for="doc in mongoResults.slice(mongoCurrentDoc, mongoCurrentDoc + mongoLimit)"
                :key="doc._id"
                class="border-l-4 border-transparent hover:border-green-500 hover:bg-gray-800/50 transition"
              >
                <div class="p-4 cursor-pointer" @click="toggleDocExpanded(doc._id)">
                  <div class="flex items-center gap-2 text-xs text-amber-400 font-mono">
                    <span>{{ expandedDocs.has(doc._id) ? '▼' : '▶' }}</span>
                    <span>{{ doc._id }}</span>
                  </div>
                </div>
                <div v-if="expandedDocs.has(doc._id)" class="px-4 pb-4">
                  <pre class="text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap break-words bg-gray-800/30 p-3 rounded">{{ JSON.stringify(doc, null, 2) }}</pre>
                </div>
              </div>
            </div>

            <!-- JSON View -->
            <div v-else-if="mongoViewType === 'json'" class="p-4">
              <pre class="text-xs text-gray-300 font-mono overflow-x-auto">{{ JSON.stringify(mongoResults.slice(mongoCurrentDoc, mongoCurrentDoc + mongoLimit), null, 2) }}</pre>
            </div>

            <!-- Grid View -->
            <div v-else-if="mongoViewType === 'grid'" class="p-4 grid grid-cols-2 gap-3">
              <div
                v-for="doc in mongoResults.slice(mongoCurrentDoc, mongoCurrentDoc + mongoLimit)"
                :key="doc._id"
                class="p-3 bg-gray-800/40 border border-white/10 rounded-lg hover:border-amber-500 transition"
              >
                <pre class="text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap break-words">{{ JSON.stringify(doc, null, 2).slice(0, 200) }}...</pre>
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
                    ? 'bg-white text-gray-900'
                    : 'bg-gray-700 hover:bg-gray-600 text-secondary'
                ]"
              >
                INDEXES
              </button>
              <button
                @click="mongoIndexView = 'search-indexes'"
                :class="[
                  'px-4 py-1.5 text-xs font-semibold rounded transition',
                  mongoIndexView === 'search-indexes'
                    ? 'bg-white text-gray-900'
                    : 'bg-gray-700 hover:bg-gray-600 text-secondary'
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
                <thead class="sticky top-0 bg-gray-800/40 border-b border-white/10">
                  <tr>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Name &amp; Definition</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Type</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Size</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Usage</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Properties</th>
                    <th class="text-left px-4 py-3 font-semibold text-secondary">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-white/5">
                  <tr v-if="mongoIndexes.length === 0" class="hover:bg-gray-800/50">
                    <td colspan="6" class="px-4 py-4 text-center text-muted">No indexes</td>
                  </tr>
                  <tr v-for="idx in mongoIndexes" :key="idx.name" class="hover:bg-gray-800/50">
                    <td class="px-4 py-3 font-mono text-amber-400">{{ idx.name }}</td>
                    <td class="px-4 py-3">
                      <span class="px-2 py-1 bg-gray-700 text-gray-300 rounded text-xs">{{ idx.type }}</span>
                    </td>
                    <td class="px-4 py-3">{{ idx.size }}</td>
                    <td class="px-4 py-3 text-gray-400">{{ idx.usage }}</td>
                    <td class="px-4 py-3">
                      <div class="flex gap-1 flex-wrap">
                        <span v-if="idx.unique" class="px-2 py-1 bg-gray-700 text-gray-300 rounded text-xs">UNIQUE</span>
                        <span v-if="idx.compound" class="px-2 py-1 bg-gray-700 text-gray-300 rounded text-xs">COMPOUND</span>
                      </div>
                    </td>
                    <td class="px-4 py-3">
                      <span class="px-2 py-1 bg-amber-900/40 text-amber-300 rounded text-xs">{{ idx.status }}</span>
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
        <!-- Header with Collection Input & Tabs -->
        <div class="panel p-4 border-b border-white/10 space-y-4">
          <div class="flex items-center justify-between">
            <div class="flex-1 max-w-sm">
              <label class="text-xs text-secondary mb-2 block font-semibold">Collection</label>
              <input
                v-model="firestoreCollection"
                type="text"
                placeholder="e.g., Results"
                @keyup.enter="queryFirestore"
                class="w-full form-input text-sm"
              />
            </div>
            <button
              @click="queryFirestore"
              :disabled="loadingFirestore || !firestoreCollection"
              class="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-gray-900 font-bold px-6 py-2 rounded-lg transition h-fit"
            >
              Load
            </button>
          </div>

          <!-- Tabs -->
          <div class="flex gap-6 border-b border-white/10 pb-0">
            <button
              @click="firestoreTab = 'data'"
              :class="[
                'px-4 py-3 text-sm font-medium transition border-b-2',
                firestoreTab === 'data'
                  ? 'text-amber-400 border-amber-500'
                  : 'text-secondary hover:text-primary border-transparent'
              ]"
            >
              Data
              <span v-if="firestoreResults.length" class="ml-2 text-xs bg-amber-500/20 px-2 py-1 rounded">{{ firestoreResults.length }}</span>
            </button>
            <button
              @click="firestoreTab = 'rules'"
              :class="[
                'px-4 py-3 text-sm font-medium transition border-b-2',
                firestoreTab === 'rules'
                  ? 'text-amber-400 border-amber-500'
                  : 'text-secondary hover:text-primary border-transparent'
              ]"
            >
              Rules
            </button>
            <button
              @click="firestoreTab = 'indexes'"
              :class="[
                'px-4 py-3 text-sm font-medium transition border-b-2',
                firestoreTab === 'indexes'
                  ? 'text-amber-400 border-amber-500'
                  : 'text-secondary hover:text-primary border-transparent'
              ]"
            >
              Indexes
            </button>
          </div>
        </div>

        <!-- Data Tab -->
        <div v-show="firestoreTab === 'data'" class="flex-1 flex flex-col min-h-0">
          <!-- Action Bar -->
          <div class="px-4 py-3 flex items-center gap-2">
            <div class="flex-1"></div>
            <div class="text-xs text-secondary">
              {{ firestoreResults.length }} documents
            </div>
            <button
              @click="queryFirestore"
              :disabled="loadingFirestore || firestoreResults.length === 0"
              class="px-2 py-1 text-secondary hover:text-primary"
              title="Refresh"
            >
              ↻
            </button>
          </div>

          <!-- Documents -->
          <div v-if="firestoreResults.length > 0" class="flex-1 overflow-auto min-h-0">
            <div class="divide-y divide-white/5">
              <div
                v-for="doc in firestoreResults"
                :key="doc.id"
                @click="selectedFirestoreDoc = doc"
                class="p-4 border-l-2 border-transparent hover:border-amber-500 hover:bg-gray-800/50 cursor-pointer transition"
              >
                <div class="text-xs text-amber-400 font-mono mb-2">{{ doc.id }}</div>
                <pre class="text-xs text-gray-300 font-mono overflow-x-auto">{{ JSON.stringify(doc.data, null, 2).slice(0, 200) }}...</pre>
              </div>
            </div>
          </div>

          <!-- Error -->
          <div v-if="firestoreError" class="flex-1 flex items-center justify-center">
            <div class="text-xs text-error font-mono text-center">{{ firestoreError }}</div>
          </div>

          <!-- Empty -->
          <div v-if="!loadingFirestore && !firestoreError && firestoreResults.length === 0" class="flex-1 flex items-center justify-center text-muted">
            <div class="text-xs text-center">No documents found</div>
          </div>
        </div>

        <!-- Rules Tab (Placeholder) -->
        <div v-show="firestoreTab === 'rules'" class="flex-1 flex items-center justify-center text-muted">
          <div class="text-xs">Security Rules view coming soon</div>
        </div>

        <!-- Indexes Tab (Placeholder) -->
        <div v-show="firestoreTab === 'indexes'" class="flex-1 flex items-center justify-center text-muted">
          <div class="text-xs">Indexes view coming soon</div>
        </div>

        <!-- Document Inspector -->
        <div v-if="selectedFirestoreDoc" class="border-t border-white/10 panel p-4 max-h-48 overflow-auto">
          <div class="flex justify-between items-center mb-3">
            <div class="text-xs text-secondary font-semibold">{{ selectedFirestoreDoc.id }}</div>
            <button
              @click="selectedFirestoreDoc = null"
              class="text-xs text-secondary hover:text-primary"
            >
              ✕
            </button>
          </div>
          <pre class="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words">{{ JSON.stringify(selectedFirestoreDoc.data, null, 2) }}</pre>
        </div>
      </div>

      <!-- GraphQL: Full-Featured Explorer -->
      <div v-if="selectedDb === 'GraphQL'" class="flex flex-col gap-4 h-full">
        <div class="panel p-4 space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs text-secondary font-semibold">Neo4j GraphQL</div>
            <div class="text-xs text-muted">{{ graphqlEndpoint.replace('https://', '').replace('/graphql/', '') }}</div>
          </div>
          <div class="flex gap-2">
            <button
              @click="loadGraphqlSchema"
              :disabled="loadingGraphql"
              class="flex-1 px-3 py-2 text-xs font-medium rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-secondary hover:text-primary transition"
            >
              {{ introspection ? 'Schema Loaded' : 'Load Schema' }}
            </button>
            <button
              @click="showVisualizer = !showVisualizer"
              :disabled="!introspection"
              class="flex-1 px-3 py-2 text-xs font-medium rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-secondary hover:text-primary transition"
            >
              {{ showVisualizer ? 'Hide Graph' : 'View Graph' }}
            </button>
            <button
              @click="executeGraphql"
              :disabled="loadingGraphql || !graphqlQuery"
              class="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-gray-900 font-bold rounded-lg transition"
            >
              {{ loadingGraphql ? '...' : 'Execute' }}
            </button>
          </div>
          <div v-if="graphqlQueryHistory.length > 0" class="flex items-center gap-2">
            <select
              @change="(e) => { graphqlQuery = e.target.value; e.target.value = '' }"
              class="flex-1 px-3 py-1.5 bg-gray-700 border-white/10 rounded text-xs text-secondary hover:text-primary transition"
            >
              <option value="">← History (last {{ graphqlQueryHistory.length }})</option>
              <option v-for="(query, idx) in graphqlQueryHistory" :key="idx" :value="query">
                {{ query.slice(0, 60) }}{{ query.length > 60 ? '...' : '' }}
              </option>
            </select>
            <button
              @click="graphqlQueryHistory = []; localStorage.removeItem('graphql-history')"
              class="px-2 py-1.5 text-xs text-gray-400 hover:text-red-400 transition"
            >
              Clear
            </button>
          </div>
        </div>

        <!-- Schema Graph Visualizer -->
        <div v-if="showVisualizer" class="flex-1 panel overflow-hidden rounded-lg min-h-0">
          <div v-if="graphNodes && Object.keys(graphNodes).length > 0" class="w-full h-full">
            <v-network-graph
              :nodes="graphNodes"
              :edges="graphEdges"
              :configs="graphConfig"
              class="w-full h-full"
            />
          </div>
          <div v-else class="flex items-center justify-center h-full text-muted">
            <div class="text-xs text-center">Load schema first to view graph</div>
          </div>
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
              <pre class="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words">{{ JSON.stringify(graphqlData, null, 2) }}</pre>
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

const databases = ['MongoDB', 'Firestore', 'GraphQL']
const selectedDb = ref('MongoDB')

// MongoDB
const mongoCollection = ref('results')
const mongoCollections = ref([])
const openMongoCollections = ref([])  // Array of { id: string, collection: string }
const activeTabId = ref(null)  // Track which tab is currently active
const tabIdCounter = ref(0)
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
const firestoreCollection = ref('Results')
const firestoreDocId = ref('')
const firestoreResults = ref([])
const firestoreError = ref('')
const loadingFirestore = ref(false)
const selectedFirestoreDoc = ref(null)
const firestoreTab = ref('data')
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
const graphqlUsername = ref('0b4b8b3f')
const graphqlPassword = ref('4Xdp76QlCd-ebl20jYgZbK1A2Hx-zw_pYbE1VLfWmxQ')
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

const queryMongo = async () => {
  if (!mongoCollection.value) return
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
        collection: mongoCollection.value,
        query: filter,
        projection,
        limit: mongoLimit.value
      }
    })
    mongoResults.value = Array.isArray(res) ? res : [res]
  } catch (err) {
    mongoError.value = err.message || 'Query failed'
  } finally {
    loadingMongo.value = false
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
  selectedFirestoreDoc.value = null

  try {
    const res = await $fetch('/api/store/firestore', {
      method: 'POST',
      body: {
        collection: firestoreCollection.value,
        docId: firestoreDocId.value || null
      }
    })

    if (firestoreDocId.value) {
      firestoreResults.value = [{ id: firestoreDocId.value, data: res }]
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

const getGraphqlAuth = () => {
  const credentials = `${graphqlUsername.value}:${graphqlPassword.value}`
  return 'Basic ' + btoa(credentials)
}

const loadGraphqlSchema = async () => {
  if (!graphqlEndpoint.value) return
  loadingGraphql.value = true
  graphqlError.value = ''

  try {
    const res = await $fetch(graphqlEndpoint.value, {
      method: 'POST',
      headers: {
        'Authorization': getGraphqlAuth(),
        'Content-Type': 'application/json'
      },
      body: {
        query: getIntrospectionQuery()
      }
    })

    if (res.errors) {
      graphqlError.value = res.errors.map(e => e.message).join('\n')
    } else if (res.data) {
      introspection.value = res.data
      buildSchemaGraph(res.data)
    }
  } catch (err) {
    graphqlError.value = err.message || 'Failed to load schema'
  } finally {
    loadingGraphql.value = false
  }
}

const executeGraphql = async () => {
  if (!graphqlEndpoint.value || !graphqlQuery.value) return
  loadingGraphql.value = true
  graphqlError.value = ''
  graphqlData.value = null

  try {
    const res = await $fetch(graphqlEndpoint.value, {
      method: 'POST',
      headers: {
        'Authorization': getGraphqlAuth(),
        'Content-Type': 'application/json'
      },
      body: {
        query: graphqlQuery.value
      }
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
    graphqlError.value = err.message || 'Query failed'
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

// Load MongoDB collections on mount
onMounted(() => {
  loadMongoCollections()
})
</script>

