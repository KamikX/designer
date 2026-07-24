import 'antdv-next/dist/reset.css'
import './assets/main.css'
import { createPinia } from 'pinia'
import { router } from './router'

import { createApp } from 'vue'
import App from './App.vue'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)
app.use(router)
app.mount('#app')
