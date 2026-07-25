import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@/utils/toast"
import { batch, For, Show, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Link } from "@/components/link"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { type FormState, headerRow, modelRow, validateCustomProvider } from "./dialog-custom-provider-form"

type Props = {
  onBack: () => void
}

export function DialogCustomProvider(props: Props) {
  const language = useLanguage()

  return (
    <Dialog
      class="h-full"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={props.onBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <CustomProviderForm />
    </Dialog>
  )
}

export function CustomProviderForm(props: { autofocus?: boolean } = {}) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const platform = usePlatform()

  const [form, setForm] = createStore<FormState>({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  })
  const [discovering, setDiscovering] = createSignal(false)
  const [discovered, setDiscovered] = createSignal<Array<{ id: string; name: string }>>([])
  const [selectedModels, setSelectedModels] = createStore<Record<string, boolean>>({})

  const fetchModels = async () => {
    const baseURL = form.baseURL.trim()
    if (!baseURL || !/^https?:\/\//.test(baseURL)) {
      setForm("err", "baseURL", language.t("provider.custom.error.baseURL.format"))
      return
    }
    setDiscovering(true)
    try {
      const headers = Object.fromEntries(
        form.headers
          .map((h) => [h.key.trim(), h.value.trim()] as const)
          .filter(([k, v]) => k && v),
      )
      const sdk = serverSDK()
      const http = sdk.server.http
      const auth =
        http?.password
          ? {
              Authorization: `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`,
            }
          : {}
            const response = await (platform.fetch ?? fetch)(`${(http?.url ?? sdk.url).replace(/\/$/, "")}/provider/discover`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          baseURL,
          apiKey: form.apiKey.trim() || undefined,
          headers: Object.keys(headers).length ? headers : undefined,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      const models = Array.isArray(data?.models) ? data.models : []
      if (models.length === 0) throw new Error(language.t("provider.custom.discover.empty"))
      setDiscovered(models)
      const next: Record<string, boolean> = {}
      for (const model of models) next[model.id] = true
      setSelectedModels(reconcile(next))
      // Prefill form models with all discovered entries so submit works immediately.
      setForm(
        "models",
        models.map((model: { id: string; name: string }) => ({
          row: `row-${model.id}`,
          id: model.id,
          name: model.name || model.id,
          err: {},
        })),
      )
      showToast({
        variant: "success",
        title: language.t("provider.custom.discover.success.title"),
        description: language.t("provider.custom.discover.success.description", { count: models.length }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast({
        variant: "error",
        title: language.t("provider.custom.discover.failed.title"),
        description: message,
      })
    } finally {
      setDiscovering(false)
    }
  }

  const applySelectedModels = () => {
    const models = discovered().filter((model) => selectedModels[model.id])
    if (models.length === 0) {
      showToast({
        variant: "error",
        title: language.t("provider.custom.discover.noneSelected.title"),
        description: language.t("provider.custom.discover.noneSelected.description"),
      })
      return
    }
    setForm(
      "models",
      models.map((model) => ({
        row: `row-${model.id}`,
        id: model.id,
        name: model.name || model.id,
        err: {},
      })),
    )
  }

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      disabledProviders: serverSync().data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(serverSync().data.provider.all.keys()),
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      const disabledProviders = serverSync().data.config.disabled_providers ?? []
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

      if (result.key) {
        await serverSDK().client.auth.set({
          providerID: result.providerID,
          auth: {
            type: "api",
            key: result.key,
          },
        })

        // Verify connectivity before saving config.
        const sdk = serverSDK()
        const http = sdk.server.http
        const authHdr = http?.password
          ? { Authorization: `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}` }
          : {}
        const resp = await (platform.fetch ?? fetch)(`${(http?.url ?? sdk.url).replace(/\/$/, "")}/provider/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHdr },
          body: JSON.stringify({ providerID: result.providerID, key: result.key }),
        })
        const data = await resp.json().catch(() => ({}))
        if (!resp.ok) {
          throw new Error(data?.error || `Verification failed (HTTP ${resp.status})`)
        }
      }

      await serverSync().updateConfig({
        provider: { [result.providerID]: result.config },
        disabled_providers: nextDisabled,
      })
      return result
    },
    onSuccess: async (result) => {
      try {
        await serverSDK().client.global.dispose()
      } catch {
        // ignore dispose failures; config already saved
      }
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
        description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">{language.t("provider.custom.title")}</div>
      </div>

      <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
        <p class="text-14-regular text-text-base">
          {language.t("provider.custom.description.prefix")}
          <Link href="https://hoyaagent.local/docs/providers" tabIndex={-1}>
            {language.t("provider.custom.description.link")}
          </Link>
          {language.t("provider.custom.description.suffix")}
        </p>

        <div class="flex flex-col gap-4">
          <TextField
            autofocus={props.autofocus ?? true}
            label={language.t("provider.custom.field.providerID.label")}
            placeholder={language.t("provider.custom.field.providerID.placeholder")}
            description={language.t("provider.custom.field.providerID.description")}
            value={form.providerID}
            onChange={(v) => setField("providerID", v)}
            validationState={form.err.providerID ? "invalid" : undefined}
            error={form.err.providerID}
          />
          <TextField
            label={language.t("provider.custom.field.name.label")}
            placeholder={language.t("provider.custom.field.name.placeholder")}
            value={form.name}
            onChange={(v) => setField("name", v)}
            validationState={form.err.name ? "invalid" : undefined}
            error={form.err.name}
          />
          <TextField
            label={language.t("provider.custom.field.baseURL.label")}
            placeholder={language.t("provider.custom.field.baseURL.placeholder")}
            value={form.baseURL}
            onChange={(v) => setField("baseURL", v)}
            validationState={form.err.baseURL ? "invalid" : undefined}
            error={form.err.baseURL}
          />
          <TextField
            label={language.t("provider.custom.field.apiKey.label")}
            placeholder={language.t("provider.custom.field.apiKey.placeholder")}
            description={language.t("provider.custom.field.apiKey.description")}
            value={form.apiKey}
            onChange={(v) => setField("apiKey", v)}
          />
          <Button
            type="button"
            size="large"
            variant="secondary"
            disabled={discovering()}
            onClick={() => void fetchModels()}
            class="self-start"
          >
            {discovering()
              ? language.t("provider.custom.discover.loading")
              : language.t("provider.custom.discover.action")}
          </Button>
          <Show when={discovered().length > 0}>
            <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
              <div class="flex items-center justify-between gap-2">
                <div class="text-12-medium text-text-weak">
                  {language.t("provider.custom.discover.result", { count: discovered().length })}
                </div>
                <div class="flex gap-2">
                  <Button type="button" size="small" variant="ghost" onClick={applySelectedModels}>
                    {language.t("provider.custom.discover.apply")}
                  </Button>
                </div>
              </div>
              <div class="max-h-40 overflow-y-auto flex flex-col gap-1">
                <For each={discovered()}>
                  {(model) => (
                    <label class="flex items-center gap-2 text-13-regular text-text-base px-1 py-1 rounded hover:bg-surface-raised-base-hover">
                      <input
                        type="checkbox"
                        checked={!!selectedModels[model.id]}
                        onChange={(e) => setSelectedModels(model.id, e.currentTarget.checked)}
                      />
                      <span class="truncate font-medium">{model.id}</span>
                      <Show when={model.name && model.name !== model.id}>
                        <span class="truncate text-text-weak">{model.name}</span>
                      </Show>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>

        <div class="flex flex-col gap-3">
          <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
          <For each={form.models}>
            {(m, i) => (
              <div class="flex gap-2 items-start" data-row={m.row}>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.models.id.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.models.id.placeholder")}
                    value={m.id}
                    onChange={(v) => setModel(i(), "id", v)}
                    validationState={m.err.id ? "invalid" : undefined}
                    error={m.err.id}
                  />
                </div>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.models.name.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.models.name.placeholder")}
                    value={m.name}
                    onChange={(v) => setModel(i(), "name", v)}
                    validationState={m.err.name ? "invalid" : undefined}
                    error={m.err.name}
                  />
                </div>
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  class="mt-1.5"
                  onClick={() => removeModel(i())}
                  disabled={form.models.length <= 1}
                  aria-label={language.t("provider.custom.models.remove")}
                />
              </div>
            )}
          </For>
          <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
            {language.t("provider.custom.models.add")}
          </Button>
        </div>

        <div class="flex flex-col gap-3">
          <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
          <For each={form.headers}>
            {(h, i) => (
              <div class="flex gap-2 items-start" data-row={h.row}>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.headers.key.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.headers.key.placeholder")}
                    value={h.key}
                    onChange={(v) => setHeader(i(), "key", v)}
                    validationState={h.err.key ? "invalid" : undefined}
                    error={h.err.key}
                  />
                </div>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.headers.value.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.headers.value.placeholder")}
                    value={h.value}
                    onChange={(v) => setHeader(i(), "value", v)}
                    validationState={h.err.value ? "invalid" : undefined}
                    error={h.err.value}
                  />
                </div>
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  class="mt-1.5"
                  onClick={() => removeHeader(i())}
                  disabled={form.headers.length <= 1}
                  aria-label={language.t("provider.custom.headers.remove")}
                />
              </div>
            )}
          </For>
          <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
            {language.t("provider.custom.headers.add")}
          </Button>
        </div>

        <Button
          class="w-auto self-start"
          type="submit"
          size="large"
          variant="primary"
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
        </Button>
      </form>
    </div>
  )
}
