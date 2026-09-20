let body = ''
for await (const chunk of process.stdin) body += chunk
const input = JSON.parse(body)
process.stdout.write(
  JSON.stringify({
    accepted: true,
    status: 'done',
    final_url: input.url,
    final_title: 'Fixture',
    actions: [{ kind: 'click', auto_approved: true }],
  })
)
