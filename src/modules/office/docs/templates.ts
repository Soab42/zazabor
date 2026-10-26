/**
 * New → a document to start from: Docs' versions of Word's familiar templates, as editor HTML.
 * Placeholder text sits in [brackets] so it's easy to find and replace.
 */

function today(): string {
  return new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function templateHtml(id: string): string {
  switch (id) {
    case "letter":
      return `
<p>[Your Name]<br>[Street Address]<br>[City, Postcode]<br>[Email] · [Phone]</p>
<p>${today()}</p>
<p>[Recipient Name]<br>[Title]<br>[Company]<br>[Street Address]<br>[City, Postcode]</p>
<p>Dear [Recipient Name],</p>
<p>[Say why you're writing in the first sentence. Keep each paragraph to one idea, and the letter to one page.]</p>
<p>[The details: what happened, what you'd like, and by when.]</p>
<p>[Close with what happens next, and thank them for their time.]</p>
<p>Sincerely,</p>
<p style="margin-top: 24pt">[Your Name]</p>`;
    case "report":
      return `
<p class="ds-title">[Report Title]</p>
<p class="ds-subtitle">[Subtitle] · ${today()}</p>
<h1>Summary</h1>
<p>[In a few sentences: what this report covers, what was found, and what you recommend.]</p>
<h1>Background</h1>
<p>[Why this work was done, and what was known before.]</p>
<h2>Scope</h2>
<ul><li><p>[What is included]</p></li><li><p>[What is left out]</p></li></ul>
<h1>Findings</h1>
<p>[The results, most important first.]</p>
<table><tbody>
<tr><th><p>Item</p></th><th><p>Result</p></th><th><p>Notes</p></th></tr>
<tr><td><p>[Item]</p></td><td><p>[Result]</p></td><td><p>[Notes]</p></td></tr>
<tr><td><p>[Item]</p></td><td><p>[Result]</p></td><td><p>[Notes]</p></td></tr>
</tbody></table>
<h1>Recommendations</h1>
<ol><li><p>[First recommendation]</p></li><li><p>[Second recommendation]</p></li></ol>
<h1>Next Steps</h1>
<p>[Who does what, and when.]</p>`;
    case "resume":
      return `
<p class="ds-title">[Your Name]</p>
<p class="ds-subtitle">[City] · [Email] · [Phone] · [LinkedIn or website]</p>
<h1>Profile</h1>
<p>[Two or three sentences on what you do best and the role you're looking for.]</p>
<h1>Experience</h1>
<h2>[Job Title] · [Company]</h2>
<p><em>[Start] – [End]</em></p>
<ul><li><p>[An achievement, with a number if you can]</p></li><li><p>[Another achievement]</p></li></ul>
<h2>[Job Title] · [Company]</h2>
<p><em>[Start] – [End]</em></p>
<ul><li><p>[An achievement]</p></li><li><p>[Another achievement]</p></li></ul>
<h1>Education</h1>
<h2>[Degree] · [School]</h2>
<p><em>[Year]</em></p>
<h1>Skills</h1>
<ul><li><p>[Skill] · [Skill] · [Skill]</p></li><li><p>[Languages]</p></li></ul>`;
    case "meeting-notes":
      return `
<p class="ds-title">[Meeting Name]</p>
<p class="ds-subtitle">${today()} · [Time] · [Place or call link]</p>
<p><strong>Attendees:</strong> [Names]</p>
<h1>Agenda</h1>
<ol><li><p>[Topic]</p></li><li><p>[Topic]</p></li><li><p>[Topic]</p></li></ol>
<h1>Notes</h1>
<p>[What was discussed, topic by topic.]</p>
<h1>Decisions</h1>
<ul><li><p>[Decision]</p></li></ul>
<h1>Action Items</h1>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>[Task] — [Owner], due [date]</p></li><li data-type="taskItem" data-checked="false"><p>[Task] — [Owner], due [date]</p></li></ul>`;
    default:
      return "<p></p>";
  }
}
