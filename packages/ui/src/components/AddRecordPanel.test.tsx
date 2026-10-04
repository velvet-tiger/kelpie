import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AddRecordPanel } from './AddRecordPanel.tsx'

afterEach(cleanup)

const COMPANIES = [
  { id: 'com_1', label: 'Northwind' },
  { id: 'com_2', label: 'Sandbox' },
]

function typeName(value: string): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value } })
}

describe('AddRecordPanel', () => {
  it('creates nothing until a name is typed', () => {
    const onCreate = vi.fn()

    render(<AddRecordPanel title="Add person" isPending={false} onCancel={vi.fn()} onCreate={onCreate} />)

    const submit = screen.getByRole('button', { name: 'Add person' }) as HTMLButtonElement

    expect(submit.disabled).toBe(true)

    typeName('   ')
    fireEvent.submit(screen.getByRole('form', { name: 'Add person' }))

    expect(submit.disabled).toBe(true)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('creates with the trimmed name', () => {
    const onCreate = vi.fn()

    render(<AddRecordPanel title="Add person" isPending={false} onCancel={vi.fn()} onCreate={onCreate} />)

    typeName('  John Smith ')
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }))

    expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: 'John Smith' })
  })

  it('needs a company when it has a company picker', () => {
    const onCreate = vi.fn()

    render(
      <AddRecordPanel
        title="Add deal"
        company={{ options: COMPANIES }}
        isPending={false}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />,
    )

    typeName('Pilot')

    const submit = screen.getByRole('button', { name: 'Add deal' }) as HTMLButtonElement

    expect(submit.disabled).toBe(true)

    fireEvent.focus(screen.getByPlaceholderText('Search companies…'))
    fireEvent.mouseDown(screen.getByText('Sandbox'))
    fireEvent.click(screen.getByText('Sandbox'))

    expect(submit.disabled).toBe(false)

    fireEvent.click(submit)

    expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: 'Pilot', companyId: 'com_2' })
  })

  it('cancels from the button and from Escape', () => {
    const onCancel = vi.fn()

    render(<AddRecordPanel title="Add person" isPending={false} onCancel={onCancel} onCreate={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('does not create twice while a create is pending', () => {
    const onCreate = vi.fn()

    render(<AddRecordPanel title="Add person" isPending onCancel={vi.fn()} onCreate={onCreate} />)

    typeName('John Smith')
    fireEvent.submit(screen.getByRole('form', { name: 'Add person' }))

    expect(onCreate).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
