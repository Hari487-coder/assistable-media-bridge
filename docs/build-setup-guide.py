"""Build the Media Bridge setup guide PDF.

House rules for the copy in here, taken from the customer support standard:
no em dashes, no invented facts, plain language over jargon. Helvetica has no
emoji glyphs, so emoji are described in words rather than drawn.
"""
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, ListFlowable, ListItem, NextPageTemplate,
    PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

OUT = r"C:\Users\Hari Prathap\Downloads\Case Study\assistable-media-bridge\docs\Media-Bridge-Setup-Guide.pdf"

INK = colors.HexColor("#12211f")
DIM = colors.HexColor("#5b6b68")
ACCENT = colors.HexColor("#0f766e")
ACCENT_SOFT = colors.HexColor("#e6f4f1")
LINE = colors.HexColor("#d5e0dd")
CODE_BG = colors.HexColor("#f4f7f6")
WARN_BG = colors.HexColor("#fdf6e3")
WARN_LINE = colors.HexColor("#e0c068")

ss = getSampleStyleSheet()

def S(name, **kw):
    base = dict(fontName="Helvetica", fontSize=10, leading=15, textColor=INK,
                alignment=TA_LEFT, spaceAfter=6)
    base.update(kw)
    return ParagraphStyle(name, **base)

Title = S("Title", fontName="Helvetica-Bold", fontSize=26, leading=30,
          textColor=ACCENT, spaceAfter=8)
Sub = S("Sub", fontSize=12, leading=17, textColor=DIM, spaceAfter=20)
H1 = S("H1", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=ACCENT,
       spaceBefore=18, spaceAfter=8)
H2 = S("H2", fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=INK,
       spaceBefore=12, spaceAfter=5)
Body = S("Body")
Small = S("Small", fontSize=9, leading=13, textColor=DIM)
Code = S("Code", fontName="Courier", fontSize=8.5, leading=12.5, textColor=INK)
CellH = S("CellH", fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=colors.white)
Cell = S("Cell", fontSize=9, leading=12.5)
CellC = S("CellC", fontName="Courier", fontSize=8, leading=11.5)


def code(text):
    t = Table([[Paragraph(l.replace(" ", "&nbsp;") or "&nbsp;", Code)] for l in text.split("\n")],
              colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 9)])


def callout(title, text, bg=WARN_BG, edge=WARN_LINE):
    inner = [Paragraph(f"<b>{title}</b>", S("CoT", fontSize=10, leading=14, spaceAfter=3)),
             Paragraph(text, S("CoB", fontSize=9.5, leading=14, spaceAfter=0))]
    t = Table([[inner]], colWidths=[165 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.8, edge),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return KeepTogether([Spacer(1, 4), t, Spacer(1, 10)])


def table(headers, rows, widths):
    data = [[Paragraph(h, CellH) for h in headers]]
    for r in rows:
        data.append([Paragraph(c, CellC if (isinstance(c, str) and c.startswith("`")) else Cell)
                     .__class__ and Paragraph(c.strip("`"), CellC if c.startswith("`") else Cell)
                     for c in r])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fafcfb")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 10)])


def steps(items):
    return ListFlowable(
        [ListItem(Paragraph(i, Body), leftIndent=16) for i in items],
        bulletType="1", leftIndent=16, bulletFontName="Helvetica-Bold",
        bulletFontSize=10, spaceAfter=8,
    )


def bullets(items):
    return ListFlowable(
        [ListItem(Paragraph(i, Body), leftIndent=14) for i in items],
        bulletType="bullet", start="circle", leftIndent=14, spaceAfter=8,
    )


def on_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(22 * mm, 16 * mm, 188 * mm, 16 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(DIM)
    canvas.drawString(22 * mm, 11 * mm, "Media Bridge setup guide")
    canvas.drawRightString(188 * mm, 11 * mm, f"Page {canvas.getPageNumber()}")
    canvas.restoreState()


def on_cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(ACCENT)
    canvas.rect(0, A4[1] - 14 * mm, A4[0], 14 * mm, stroke=0, fill=1)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=22 * mm, rightMargin=22 * mm,
                      topMargin=24 * mm, bottomMargin=22 * mm,
                      title="Media Bridge Setup Guide",
                      author="Assistable")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
doc.addPageTemplates([
    PageTemplate(id="cover", frames=[frame], onPage=on_cover),
    PageTemplate(id="body", frames=[frame], onPage=on_page),
])

E = []
A = E.append

# ---------------------------------------------------------------- cover
A(Spacer(1, 26 * mm))
A(Paragraph("Media Bridge", Title))
A(Paragraph("Let your AI assistant read voice notes, photos and documents", Sub))
A(Paragraph(
    "When a customer sends a voice note, a photo of a receipt, or a PDF into your CRM, your AI "
    "assistant cannot see it. It has no eyes and no ears, so the message arrives empty and the "
    "assistant either says nothing useful or guesses.", Body))
A(Paragraph(
    "The Media Bridge fixes that. It watches for attachments, reads them, and hands the assistant "
    "the contents as plain text so it can reply properly.", Body))
A(Spacer(1, 6))
A(callout("Before you start",
          "Set aside about twenty minutes. You will need access to your CRM and to your Assistable "
          "dashboard. Nothing here involves writing code. If you get stuck at any step, the "
          "troubleshooting section near the end lists every error message and what it means.",
          bg=ACCENT_SOFT, edge=ACCENT))

A(Paragraph("What you will do", H1))
A(steps([
    "Collect four things: two API keys, one CRM token, and your account IDs.",
    "Paste them into the setup page, once for a single location or all at once for many.",
    "Add one line to each assistant's prompt.",
    "Send yourself a voice note to check it works.",
]))
A(Paragraph(
    "Steps 1 and 4 are where almost everyone gets stuck, so those have the most detail.", Small))

A(NextPageTemplate("body"))
A(PageBreak())

# ---------------------------------------------------------------- part 1
A(Paragraph("Part 1. Collect the four things you need", H1))
A(Paragraph(
    "Gather all four before you open the setup page. The page checks every one of them against the "
    "live services before it saves anything, so a wrong value is rejected straight away rather than "
    "failing quietly later.", Body))

A(Paragraph("1. Your Assistable v3 API key", H2))
A(steps([
    "Open your Assistable dashboard.",
    "Go to Integrations, then API Key.",
    "Create a key and copy it. It starts with <font face='Courier'>ask_live_</font>.",
]))
A(callout("If you are connecting more than one location",
          "The key must be workspace wide, meaning it can reach every subaccount you plan to list. "
          "A key created inside one single subaccount can only ever see that one, and every other "
          "row will fail. If you are unsure, create the key at the top level of your workspace."))

A(Paragraph("2. Your CRM Private Integration Token", H2))
A(Paragraph(
    "This is what lets the bridge read the attachments your customers send. It only ever reads. "
    "It never sends messages, never edits contacts, and never changes anything in your CRM.", Body))
A(steps([
    "In your CRM, go to Settings, then Private Integrations.",
    "Create a new private integration.",
    "Tick exactly these two permissions and nothing else:",
]))
A(code("conversations.readonly\nconversations/message.readonly"))
A(steps([
    "Copy the token it gives you.",
]))
A(callout("Only tick those two",
          "You may see many other permissions offered, including ones that can send documents, "
          "publish ads or edit subscriptions. The bridge does not use any of them. Ticking extra "
          "permissions gives away access you did not need to give. Your CRM says the same thing on "
          "that screen: grant the minimum."))
A(Paragraph("Agency level or one per location?", H2))
A(Paragraph(
    "Private integrations can be created at the agency level or inside a single location, and which "
    "one you can use depends on how your CRM account is set up. Both work here, so you do not need "
    "to know in advance:", Body))
A(bullets([
    "If you can create one at agency level with those two permissions, one token covers everything. "
    "Paste it into the shared field.",
    "If those two permissions are not offered at agency level, create one inside each location "
    "instead. Leave the shared field blank and attach each token to its own row. Part 2 shows how.",
]))

A(Paragraph("3. Your AI provider key", H2))
A(Paragraph(
    "This is the service that actually reads the attachment. You bring your own key, so the cost "
    "and the data stay with you.", Body))
A(bullets([
    "<b>Gemini</b> is recommended. Its free tier covers voice notes, images and PDFs. Get a key at "
    "Google AI Studio.",
    "<b>OpenAI</b> also works. It handles voice notes and images, but not PDFs.",
]))

A(Paragraph("4. Your IDs", H2))
A(Paragraph(
    "This is the step that trips people up most often, because two of these look similar and live "
    "in different places. Read this part slowly.", Body))
A(table(
    ["What it is", "Where you find it", "What it looks like"],
    [
        ["<b>Subaccount ID</b><br/>Assistable's own ID for the account",
         "Open that subaccount in your Assistable dashboard and look at the address bar. It is the "
         "part straight after <font face='Courier'>/portal/</font>",
         "`clx7k2p9a0001qw8h3n5v2m4t`"],
        ["<b>Location ID</b><br/>your CRM's ID for the same account",
         "In your CRM, under that location's settings",
         "`nYsYTNNoV948IVhNfmOj`"],
        ["<b>Assistant ID</b><br/>which assistant should reply",
         "Open the assistant in Assistable and look at the address bar",
         "`cms1hsf1n0033l704voi99bks`"],
    ],
    [42 * mm, 68 * mm, 55 * mm]))
A(callout("The subaccount ID and the location ID are not the same thing",
          "They refer to the same business, but they are two different IDs from two different "
          "systems. Putting the location ID in both places, or swapping the two around, is the most "
          "common mistake by a wide margin. The setup page now catches it and says so, but it is "
          "much quicker to get right the first time."))
A(Paragraph(
    "If a subaccount has only one assistant, you can leave the assistant ID out entirely and it "
    "will be filled in for you.", Small))

A(PageBreak())

# ---------------------------------------------------------------- part 2
A(Paragraph("Part 2. Connect your accounts", H1))
A(Paragraph(
    "Open the address your account manager gave you. It ends in <font face='Courier'>.onrender.com</font>. "
    "You will see a form. There are two ways in.", Body))

A(Paragraph("Option A. Just one location", H2))
A(Paragraph("Use the form on the front page and fill in:", Body))
A(bullets([
    "<b>Label</b>, any name you will recognise later, such as the clinic name.",
    "<b>Location ID</b>, from your CRM.",
    "<b>Assistant ID</b>, the assistant that should reply.",
    "<b>Subaccount ID</b>, only needed if your API key covers more than one subaccount. "
    "If it does, this is not optional.",
    "Your three credentials from Part 1.",
]))
A(Paragraph("Press <b>Validate and connect</b>. Every value is checked live before anything saves.", Body))

A(Paragraph("Option B. Several locations at once", H2))
A(Paragraph(
    "Click <b>Connect several subaccounts at once</b>. Paste your three credentials once at the top, "
    "then list your locations underneath, one per line, in this order:", Body))
A(code("subaccountId, locationId, assistantId, label"))
A(Paragraph("A real example with three locations:", Body))
A(code(
    "clx7k2p9a0001qw8h3n5v2m4t, nYsYTNNoV948IVhNfmOj, cms1hsf1n0033l704voi99bks, Main Street Dental\n"
    "clx8m4r2b0002qw8h7j1k9p3z, kQ2mNb71xTfLpR3wZaYd, , Riverside Chiropractic\n"
    "clx9n5s3c0004qw8h2v6b8n1m, wR4pLc82yUgMqS5xBbZe, , Lakeside Vets, pit=pit-abc123"))
A(Paragraph("Reading those three lines:", Body))
A(bullets([
    "Line 1 names its assistant explicitly.",
    "Line 2 leaves the assistant blank, shown by the two commas together. That subaccount has only "
    "one assistant, so it is filled in automatically.",
    "Line 3 adds <font face='Courier'>pit=</font> followed by its own CRM token, for a location "
    "that needs a different one from the shared field.",
]))
A(bullets([
    "You can separate with commas or tabs, so pasting a column straight out of a spreadsheet works.",
    "Lines starting with <font face='Courier'>#</font> are ignored, so you can keep a header row.",
    "A label can contain commas. Anything after the assistant is treated as the label.",
    "Up to 50 locations per submission.",
]))
A(callout("Getting it wrong is safe",
          "Each line is checked on its own. If one fails, the rest still connect. Fix the broken "
          "line and paste the whole list again: the locations that already worked are simply "
          "updated in place rather than added twice. Re-submitting the same list is the normal way "
          "to work, not something to avoid.",
          bg=ACCENT_SOFT, edge=ACCENT))

A(PageBreak())

# ---------------------------------------------------------------- part 3 & 4
A(Paragraph("Part 3. Add one line to each assistant", H1))
A(Paragraph(
    "This step is easy to skip and nothing works properly without it. The bridge gives your "
    "assistant the ability to read attachments, but the assistant still needs telling to use it.", Body))
A(Paragraph("Open each connected assistant, and add this to its prompt:", Body))
A(code(
    "If the contact sends, or refers to, a photo, image, screenshot,\n"
    "document, or voice note, ALWAYS call the analyze_attachment tool\n"
    "first to read it, then respond based on its content. Never say you\n"
    "cannot open attachments."))
A(Paragraph(
    "The setup page shows you this same text when you finish, so you can copy it from there.", Small))

A(Paragraph("Part 4. Test it", H1))
A(steps([
    "From your own phone, send a <b>voice note with no text</b> to one of your connected numbers.",
    "Wait up to a minute.",
    "The assistant should reply about what you actually said.",
]))
A(Paragraph(
    "Open your dashboard while you wait. The link was given to you when you connected, and there is "
    "one per location. You will see the activity appear in order: poll, then detect, then wake, then "
    "the tool call.", Body))
A(callout("A voice note with no caption is the best test",
          "That is precisely the case that used to be dropped. If you add text to the message, the "
          "assistant may reply to the text and you will not have tested anything."))

A(Paragraph("Part 5. Your dashboard", H1))
A(Paragraph("Each connected location has its own private dashboard link. It shows:", Body))
A(table(
    ["Control", "What it does"],
    [
        ["<b>Recent activity</b>", "A live feed of what the bridge has seen and done. This is the "
         "first place to look if something seems wrong."],
        ["<b>Disable bridge</b>", "Pauses everything for this location without deleting anything."],
        ["<b>Waker on and off</b>", "Stops the bridge checking for new attachments automatically. "
         "The assistant can still read one if it is asked to."],
        ["<b>Voice notes, Images</b>", "Turn either kind of attachment off on its own."],
        ["<b>Extra guidance</b>", "Tell the reader what to look out for in this account. See below."],
        ["<b>Attach tool to all assistants</b>", "Makes every assistant in the subaccount able to "
         "read attachments straight away, rather than from the first time each one is sent something."],
    ],
    [46 * mm, 119 * mm]))

A(Paragraph("Extra guidance", H2))
A(Paragraph(
    "By default the reader does a general job: it writes out what a voice note said, and reads all "
    "the text in an image. If a particular account mostly receives one kind of thing, you can say "
    "so and it will pay closer attention. For example:", Body))
A(code(
    "Receipts are common here. Always extract the amount, currency,\n"
    "date, payer name and any reference or transaction number."))
A(callout("This changes what is read, not what is true",
          "A screenshot can be edited in seconds, and these models sometimes misread digits. Use "
          "what the reader gives you to help a person or a system check a payment. Never let the "
          "assistant confirm to a customer that something is paid based on a picture alone."))

A(PageBreak())

# ---------------------------------------------------------------- troubleshooting
A(Paragraph("Part 6. If something goes wrong", H1))
A(Paragraph("Every message the setup page can show you, and what to do about it.", Body))
A(table(
    ["What you see", "What it means and how to fix it"],
    [
        ["No GHL Private Integration Token for this location",
         "You left the shared token field empty and this line has no "
         "<font face='Courier'>pit=</font> on it either. Add the token in one place or the other."],
        ["The Subaccount ID and the GHL location ID are the same value",
         "You have pasted the same ID into both columns. They are different IDs. Get the subaccount "
         "one from the dashboard address bar, after <font face='Courier'>/portal/</font>."],
        ["No assistants are visible in subaccount ...",
         "Almost always means the first column is not really a subaccount ID. Check it against the "
         "address bar. If the ID is right, that subaccount genuinely has no assistants yet."],
        ["Assistant ... is not in subaccount ...",
         "The assistant on this line belongs to a different subaccount. The message lists the "
         "assistants that ARE available, so pick one of those."],
        ["GHL Private Integration Token failed validation",
         "The token is wrong, expired, or missing the two permissions from Part 1. Check both "
         "permissions are ticked."],
        ["Assistable v3 API key failed validation",
         "The key is wrong or has been revoked. Create a new one and try again."],
        ["Could not auto-create the analyze_attachment tool",
         "Everything else worked. Press <b>Retry tool setup</b> on the dashboard."],
    ],
    [52 * mm, 113 * mm]))

A(Paragraph("The assistant is not replying to attachments", H2))
A(bullets([
    "Check you completed Part 3. This is the most common cause by far.",
    "Open the dashboard and look at Recent activity. If you see nothing at all, the bridge is not "
    "seeing the conversation. If you see poll and detect but no wake, tell your account manager.",
    "Check the location is enabled and the waker is on.",
]))

A(Paragraph("Part 7. Common questions", H1))

A(Paragraph("Why do I see requests to my API every few seconds?", H2))
A(Paragraph(
    "That is normal. The bridge checks each connected location every 25 seconds to spot new "
    "attachments. Three locations means three requests every 25 seconds. It is a steady beat, not "
    "a runaway loop. If a key stops working, the bridge gives up on that location after three "
    "failures and says so on the dashboard rather than retrying forever.", Body))

A(Paragraph("What happens to my customers' photos and recordings?", H2))
A(Paragraph(
    "They are never stored. An attachment is read in memory, passed to your AI provider, and "
    "discarded. The activity feed records that something happened and what type it was, never the "
    "contents. Your keys are encrypted where they are stored.", Body))

A(Paragraph("Does it understand emoji?", H2))
A(Paragraph(
    "An emoji inside a normal message reaches your assistant as usual and it can respond to it. A "
    "reaction, meaning an emoji tapped onto a message rather than sent as one, is deliberately "
    "ignored. A thumbs-up on your last message almost always means the conversation is finished, "
    "and replying to it would be talking for the sake of talking.", Body))

A(Paragraph("Can I connect the same location twice?", H2))
A(Paragraph(
    "You do not need to. Each location is connected once, and the bridge follows whichever "
    "assistant is handling the conversation, so several assistants in one subaccount are all "
    "covered. Submitting the same location again simply updates it rather than creating a second "
    "copy.", Body))

A(Paragraph("What does it cost to run?", H2))
A(Paragraph(
    "The bridge itself is free and runs on your own instance. You pay only your AI provider for "
    "what it reads, and the Gemini free tier covers a lot. Nothing is shared with anyone else and "
    "no one else can see your data.", Body))

A(Spacer(1, 12))
A(callout("Still stuck?",
          "Send your account manager two things: a screenshot of the setup page with your IDs "
          "visible, and a screenshot of Recent activity from the dashboard. Those two together "
          "usually identify the problem immediately. Never send anyone your API keys or tokens.",
          bg=ACCENT_SOFT, edge=ACCENT))

doc.build(E)
print("wrote", OUT)
