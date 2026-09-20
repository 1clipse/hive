// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { WINDOWS_DRIVES_ROOT } from '../../src/shared/fs-browse.js'
import type { CommandPreset, FsBrowseResponse, FsProbeResponse } from '../../web/src/api.js'
import { ServerBrowseDialog } from '../../web/src/workspace/ServerBrowseDialog.js'

const json = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as Response

const presets: CommandPreset[] = [
  { args: [], available: true, command: 'claude', displayName: 'Claude Code (CC)', id: 'claude' },
]

type FetchStub = {
  browse: FsBrowseResponse | ((path: string) => FsBrowseResponse)
  probe?: (path: string) => FsProbeResponse
}

const stubFetch = ({ browse, probe }: FetchStub) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    const u = new URL(url, 'http://127.0.0.1')
    if (u.pathname === '/api/fs/browse') {
      const q = u.searchParams.get('path') ?? ''
      return json(typeof browse === 'function' ? browse(q) : browse)
    }
    if (u.pathname === '/api/fs/probe') {
      const q = u.searchParams.get('path') ?? ''
      const defaultProbe: FsProbeResponse = {
        current_branch: null,
        exists: true,
        is_dir: true,
        is_git_repository: false,
        ok: true,
        path: q,
        suggested_name: q.split(/[\\/]/).filter(Boolean).pop() ?? '',
      }
      return json(probe ? probe(q) : defaultProbe)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ServerBrowseDialog — B8 paste-path sanitization', () => {
  test('derives a workspace name for manual Windows paths from the virtual drive root', async () => {
    stubFetch({
      browse: {
        current_path: WINDOWS_DRIVES_ROOT,
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: null,
        entries: [
          { is_dir: true, is_git_repository: false, name: 'C:', path: 'C:\\' },
          { is_dir: true, is_git_repository: false, name: 'D:', path: 'D:\\' },
        ],
        error: null,
        ok: true,
      },
      probe: (path) => ({
        current_branch: null,
        exists: path !== WINDOWS_DRIVES_ROOT,
        is_dir: path !== WINDOWS_DRIVES_ROOT,
        is_git_repository: false,
        ok: path !== WINDOWS_DRIVES_ROOT,
        path,
        suggested_name: '',
      }),
    })
    const onCreate = vi.fn()
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={onCreate}
      />
    )

    const toggle = await screen.findByText(/paste|absolute|manual/i)
    fireEvent.click(toggle)
    fireEvent.change(await screen.findByTestId('fs-manual-path'), {
      target: { value: '"D:\\code\\project"' },
    })

    await waitFor(() => {
      expect(screen.getByTestId('fs-preview-name-input')).toHaveValue('project')
      expect(screen.getByTestId('add-workspace-create')).toBeEnabled()
    })
    fireEvent.click(screen.getByTestId('add-workspace-create'))

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project', path: 'D:\\code\\project' })
    )
  })

  test('strips Windows-style "Copy as path" wrapping quotes before submitting', async () => {
    stubFetch({
      browse: {
        current_path: 'C:\\sandbox',
        root_path: 'C:\\sandbox',
        parent_path: null,
        entries: [],
        error: null,
        ok: true,
      },
    })
    const onCreate = vi.fn()
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={onCreate}
      />
    )

    // Expand the "paste absolute path" advanced section.
    const toggle = await screen.findByText(/paste|absolute|manual/i)
    fireEvent.click(toggle)
    const manualInput = await screen.findByTestId('fs-manual-path')
    fireEvent.change(manualInput, { target: { value: '"C:\\Users\\me\\project"' } })

    const nameInput = screen.getByTestId('fs-preview-name-input')
    fireEvent.change(nameInput, { target: { value: 'Alpha' } })

    fireEvent.click(screen.getByTestId('add-workspace-create'))

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1)
    })
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'C:\\Users\\me\\project', name: 'Alpha' })
    )
  })
})

describe('ServerBrowseDialog — B14 breadcrumb separator', () => {
  test('clears the selected path when navigation returns an unreadable-directory error', async () => {
    const responses: Record<string, FsBrowseResponse> = {
      '': {
        current_path: 'C:\\sandbox',
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: 'C:\\',
        entries: [
          { is_dir: true, is_git_repository: false, name: 'locked', path: 'C:\\sandbox\\locked' },
        ],
        error: null,
        ok: true,
      },
      'C:\\sandbox\\locked': {
        current_path: 'C:\\sandbox\\locked',
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: 'C:\\sandbox',
        entries: [],
        error: 'Access denied',
        ok: false,
      },
    }
    const onCreate = vi.fn()
    stubFetch({
      browse: (path) => {
        const response = responses[path]
        if (!response) throw new Error(`Unexpected browse path: ${path}`)
        return response
      },
    })
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={onCreate}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('add-workspace-create')).toBeEnabled()
      expect(screen.getByTestId('fs-preview-path')).toHaveTextContent('C:\\sandbox')
    })

    fireEvent.click(await screen.findByTestId('fs-entry-open-locked'))

    await waitFor(() => {
      expect(screen.getByTestId('fs-browse-error')).toHaveTextContent('Access denied')
      expect(screen.getByTestId('fs-preview-path')).toHaveTextContent('—')
      expect(screen.getByTestId('add-workspace-create')).toBeDisabled()
    })
    fireEvent.click(screen.getByTestId('add-workspace-create'))
    expect(onCreate).not.toHaveBeenCalled()
  })

  test('renders the Windows drives virtual root as This PC', async () => {
    stubFetch({
      browse: {
        current_path: 'C:\\Users\\me',
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: 'C:\\Users',
        entries: [],
        error: null,
        ok: true,
      },
    })
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={() => {}}
      />
    )

    const breadcrumb = await screen.findByTestId('fs-breadcrumb')
    await waitFor(() => {
      expect(within(breadcrumb).getAllByText('This PC').length).toBeGreaterThan(0)
      expect(within(breadcrumb).getByText('C:')).toBeInTheDocument()
      expect(within(breadcrumb).getByText('Users')).toBeInTheDocument()
      expect(within(breadcrumb).getByText('me')).toBeInTheDocument()
    })
    expect(screen.getByTestId('fs-root-path')).toHaveTextContent('This PC')
  })

  test('Windows parent navigation can climb from HOME back to This PC drives', async () => {
    const responses: Record<string, FsBrowseResponse> = {
      '': {
        current_path: 'C:\\Users\\28018',
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: 'C:\\Users',
        entries: [],
        error: null,
        ok: true,
      },
      'C:\\Users': {
        current_path: 'C:\\Users',
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: 'C:\\',
        entries: [
          { is_dir: true, is_git_repository: false, name: '28018', path: 'C:\\Users\\28018' },
        ],
        error: null,
        ok: true,
      },
      'C:\\': {
        current_path: 'C:\\',
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: WINDOWS_DRIVES_ROOT,
        entries: [{ is_dir: true, is_git_repository: false, name: 'Users', path: 'C:\\Users' }],
        error: null,
        ok: true,
      },
      [WINDOWS_DRIVES_ROOT]: {
        current_path: WINDOWS_DRIVES_ROOT,
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: null,
        entries: [
          { is_dir: true, is_git_repository: false, name: 'C:', path: 'C:\\' },
          { is_dir: true, is_git_repository: false, name: 'D:', path: 'D:\\' },
        ],
        error: null,
        ok: true,
      },
    }
    const browsePaths: string[] = []
    stubFetch({
      browse: (path) => {
        browsePaths.push(path)
        const response = responses[path]
        if (!response) throw new Error(`Unexpected browse path: ${path}`)
        return response
      },
    })
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={() => {}}
      />
    )

    const up = await screen.findByLabelText(/parent directory/i)
    await waitFor(() => {
      expect(within(screen.getByTestId('fs-breadcrumb')).getByText('28018')).toBeInTheDocument()
    })

    fireEvent.click(up)
    await waitFor(() => {
      expect(within(screen.getByTestId('fs-breadcrumb')).getByText('Users')).toBeInTheDocument()
      expect(within(screen.getByTestId('fs-breadcrumb')).queryByText('28018')).toBeNull()
    })

    fireEvent.click(up)
    await waitFor(() => {
      expect(within(screen.getByTestId('fs-breadcrumb')).getByText('C:')).toBeInTheDocument()
      expect(within(screen.getByTestId('fs-breadcrumb')).queryByText('Users')).toBeNull()
    })

    fireEvent.click(up)
    await waitFor(() => {
      expect(screen.getByTestId('fs-entry-D:')).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/parent directory/i)).toBeDisabled()
    expect(browsePaths).toEqual(['', 'C:\\Users', 'C:\\', WINDOWS_DRIVES_ROOT])
  })

  test('Windows drive shortcut jumps from a user folder directly to This PC', async () => {
    const responses: Record<string, FsBrowseResponse> = {
      '': {
        current_path: 'C:\\Users\\28018',
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: 'C:\\Users',
        entries: [],
        error: null,
        ok: true,
      },
      [WINDOWS_DRIVES_ROOT]: {
        current_path: WINDOWS_DRIVES_ROOT,
        root_path: WINDOWS_DRIVES_ROOT,
        parent_path: null,
        entries: [
          { is_dir: true, is_git_repository: false, name: 'C:', path: 'C:\\' },
          { is_dir: true, is_git_repository: false, name: 'D:', path: 'D:\\' },
        ],
        error: null,
        ok: true,
      },
    }
    const browsePaths: string[] = []
    stubFetch({
      browse: (path) => {
        browsePaths.push(path)
        const response = responses[path]
        if (!response) throw new Error(`Unexpected browse path: ${path}`)
        return response
      },
    })
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={() => {}}
      />
    )

    const drivesButton = await screen.findByTestId('fs-browse-drives')
    fireEvent.click(drivesButton)

    await waitFor(() => {
      expect(screen.getByTestId('fs-entry-D:')).toBeInTheDocument()
      expect(screen.queryByTestId('fs-browse-drives')).toBeNull()
    })
    expect(browsePaths).toEqual(['', WINDOWS_DRIVES_ROOT])
  })

  test('renders backslash separators between breadcrumb segments for a Windows-style path', async () => {
    stubFetch({
      browse: {
        current_path: 'C:\\sandbox\\alpha',
        root_path: 'C:\\sandbox',
        parent_path: 'C:\\sandbox',
        entries: [],
        error: null,
        ok: true,
      },
    })
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={() => {}}
      />
    )

    const breadcrumb = await screen.findByTestId('fs-breadcrumb')
    await waitFor(() => {
      expect(within(breadcrumb).getByText('alpha')).toBeInTheDocument()
    })
    // Build the visible separator list (excluding the up-arrow / button spacer).
    const separators = within(breadcrumb)
      .getAllByText((_, node) => {
        if (!node) return false
        if (node.tagName.toLowerCase() !== 'span') return false
        const text = node.textContent ?? ''
        return text === '/' || text === '\\'
      })
      .map((n) => n.textContent)
    expect(separators).toContain('\\')
    expect(separators).not.toContain('/')
  })

  test('renders forward-slash separators between breadcrumb segments for a POSIX-style path', async () => {
    stubFetch({
      browse: {
        current_path: '/sandbox/alpha',
        root_path: '/sandbox',
        parent_path: '/sandbox',
        entries: [],
        error: null,
        ok: true,
      },
    })
    render(
      <ServerBrowseDialog
        open
        commandPresetError={null}
        commandPresetId="claude"
        commandPresets={presets}
        onClose={() => {}}
        onCommandPresetChange={() => {}}
        onCreate={() => {}}
      />
    )

    const breadcrumb = await screen.findByTestId('fs-breadcrumb')
    await waitFor(() => {
      expect(within(breadcrumb).getByText('alpha')).toBeInTheDocument()
    })
    const separators = within(breadcrumb)
      .getAllByText((_, node) => {
        if (!node) return false
        if (node.tagName.toLowerCase() !== 'span') return false
        const text = node.textContent ?? ''
        return text === '/' || text === '\\'
      })
      .map((n) => n.textContent)
    expect(separators).toContain('/')
    expect(separators).not.toContain('\\')
  })
})
