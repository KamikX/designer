import { h } from 'vue'
import { App, Button } from 'antdv-next'
import { t, uiMessage } from '@renderer/i18n'
import { useArtifactStore } from '@renderer/stores/artifact'

let pending: Promise<boolean> | null = null

export function useCodeEdits(): {
  confirmEdits: () => Promise<boolean>
  save: () => Promise<void>
  discard: () => void
} {
  const store = useArtifactStore()
  const { modal, message } = App.useApp()

  async function save(): Promise<void> {
    try {
      await store.saveEdits()
    } catch (error) {
      message.error(uiMessage(String(error)))
      throw error
    }
  }

  function confirmEdits(): Promise<boolean> {
    if (pending) return pending
    if (store.saving) return Promise.resolve(false)
    if (!store.dirty) return Promise.resolve(true)
    pending = new Promise<boolean>((resolve) => {
      const finish = (result: boolean): void => {
        pending = null
        resolve(result)
      }
      const dialog = modal.confirm({
        title: t('code.unsaved'),
        content: h(
          'div',
          { style: { maxHeight: '60vh', overflowY: 'auto', overscrollBehavior: 'contain' } },
          t('code.unsavedPrompt')
        ),
        okText: t('common.save'),
        cancelText: t('common.cancel'),
        maskClosable: false,
        keyboard: false,
        onOk: async () => {
          await save()
          finish(true)
        },
        onCancel: () => finish(false),
        footer: (_origin, { OkBtn, CancelBtn }) =>
          h(
            'div',
            {
              style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }
            },
            [
              h(CancelBtn),
              h(
                Button,
                {
                  disabled: store.saving,
                  onClick: () => {
                    store.discardEdits()
                    dialog.destroy()
                    finish(true)
                  }
                },
                () => t('code.discard')
              ),
              h(OkBtn)
            ]
          )
      })
    })
    return pending
  }

  function discard(): void {
    modal.confirm({
      title: t('code.discardPrompt'),
      okText: t('code.discard'),
      cancelText: t('common.cancel'),
      onOk: () => store.discardEdits()
    })
  }

  return { confirmEdits, save, discard }
}

export function useCodeEditNavigation(confirmEdits: () => Promise<boolean>): void {
  const artifact = useArtifactStore()
  onBeforeRouteLeave(() => confirmEdits())
  onBeforeRouteUpdate((to, from) => to.params.id === from.params.id || confirmEdits())

  let closing = false
  function beforeUnload(event: BeforeUnloadEvent): void {
    if ((!artifact.dirty && !artifact.saving) || closing) return
    event.preventDefault()
    event.returnValue = ''
    void confirmEdits().then((proceed) => {
      if (!proceed) return
      closing = true
      window.close()
    })
  }
  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
}
