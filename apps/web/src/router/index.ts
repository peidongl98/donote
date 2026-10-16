import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useWebdavStore } from '@/stores/webdav';

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean;
    guestOnly?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/notes/:id',
    name: 'note',
    component: () => import('@/views/NoteEditView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/folders',
    name: 'folders',
    component: () => import('@/views/FoldersView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/folders/:id',
    name: 'folder',
    component: () => import('@/views/FolderDetailView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/trash',
    name: 'trash',
    component: () => import('@/views/TrashView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { requiresAuth: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach((to) => {
  const webdav = useWebdavStore();

  if (to.meta.requiresAuth && !webdav.isConnected) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guestOnly && webdav.isConnected) {
    return { name: 'home' };
  }
  return true;
});
