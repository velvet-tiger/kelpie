import {
  useCreatePipelineStage,
  usePipelineStages,
  useRemovePipelineStage,
  useUpdatePipelineStage,
} from '../api/resources/pipelineStages.ts'
import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { StageSettings } from '../components/StageSettings.tsx'

/** The opportunity pipeline's stage settings, on the shared `StageSettings` editor. */
export function OpportunityStageSettingsPage(): React.JSX.Element {
  const stages = usePipelineStages('opportunity')
  const createStage = useCreatePipelineStage()
  const updateStage = useUpdatePipelineStage()
  const removeStage = useRemovePipelineStage()

  if (stages.error !== null) {
    return <ErrorPanel error={stages.error} />
  }

  if (stages.isLoading) {
    return <LoadingPanel label="Loading stages…" />
  }

  const ordered = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const writeError = createStage.error ?? updateStage.error ?? removeStage.error

  return (
    <>
      {writeError !== null && (
        <div className="mx-auto mb-3 max-w-xl">
          <ErrorPanel error={writeError} />
        </div>
      )}
      <StageSettings
        title="Opportunity stages"
        backTo="/opportunities"
        backLabel="Opportunities"
        recordNoun="opportunity"
        stages={ordered}
        onRename={(id, label) => {
          updateStage.run({ id, changes: { label } })
        }}
        onReorder={(activeId, overId) => {
          const position = ordered.findIndex((stage) => stage.id === overId)

          if (position >= 0) {
            updateStage.run({ id: activeId, changes: { sortOrder: position } })
          }
        }}
        onToggleOpen={(id, open) => {
          updateStage.run({ id, changes: { open } })
        }}
        onAdd={(label) => {
          createStage.run({ kind: 'opportunity', label })
        }}
        onRemove={(id, moveToId) => {
          removeStage.run({ id, moveToId })
        }}
      />
    </>
  )
}
